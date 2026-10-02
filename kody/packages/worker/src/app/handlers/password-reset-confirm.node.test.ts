import { expect, test, vi } from 'vitest'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { hashPasswordResetToken } from '#worker/identity/password-reset-tokens.ts'

const mockSendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mockSendCloudflareEmail(...args),
}))

const { createPasswordResetConfirmHandler } =
	await import('./password-reset.ts')

function confirmRequest(token: string) {
	return {
		request: new Request('https://kody.codes/password-reset/confirm', {
			method: 'POST',
			body: JSON.stringify({ token, password: 'brand-new-password' }),
		}),
		url: new URL('https://kody.codes/password-reset/confirm'),
		params: {},
	} as never
}

async function count(
	store: Awaited<ReturnType<typeof createTestDb>>,
	sql: string,
) {
	return (await store.pg.query<{ count: number }>(sql)).rows[0]!.count
}

test('password reset confirm resolves the link owner and clears only their TOTP, passkeys, and linked providers', async () => {
	await using store = await createTestDb()
	const email = 'reset-owner@example.com'
	const passwordHash = await createPasswordHash('old-password-ok')
	const stableUserId = await createStableUserIdFromEmail(email)
	const bystanderId = await createStableUserIdFromEmail('bystander@example.com')
	const token = 'b'.repeat(64)
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (1, 'reset-owner', $1, $2, $3, '2026-01-01T00:00:00.000Z'),
		        (2, 'bystander', 'bystander@example.com', $4, $3, '2026-01-01T00:00:00.000Z')`,
		[email, stableUserId, passwordHash, bystanderId],
	)
	await store.pg.exec(`
		INSERT INTO verifications (type, target, secret, algorithm, digits, period, char_set)
		VALUES ('2fa', '1', 'RESETSECRET', 'SHA-1', 6, 30, '0123456789'),
		       ('2fa-verify', '1', 'PENDINGSECRET', 'SHA-1', 6, 30, '0123456789'),
		       ('2fa', '2', 'BYSTANDER', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO passkeys (id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name)
		VALUES ('reset-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj', 1,
			'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', 'laptop'),
		       ('bystander-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj', 2,
			'YnlzdGFuZGVy', 0, 'multiDevice', 1, 'internal', 'phone');
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'reset-github', 1, 'reset-owner'),
		       ('github', 'bystander-github', 2, 'bystander');
	`)
	await store.pg.query(
		`INSERT INTO password_resets (user_id, token_hash, expires_at)
		 VALUES (1, $1, $2), (2, $3, $2)`,
		[
			await hashPasswordResetToken(token),
			Date.now() + 60_000,
			await hashPasswordResetToken('c'.repeat(64)),
		],
	)

	const revokedGrantIds = new Array<string>()
	const handler = createPasswordResetConfirmHandler({
		// Pre-auth writer: no account context, so RLS shows it no rows.
		APP_DB: store.forUser().db,
		APP_DB_FOR_USER: (userId: string) => store.forUser(userId).db,
		APP_BASE_URL: 'https://kody.codes',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		OAUTH_PROVIDER: {
			listUserGrants: async (userId: string) => {
				if (userId !== stableUserId) throw new Error(`unexpected ${userId}`)
				return {
					items: revokedGrantIds.includes('grant-1')
						? []
						: [{ id: 'grant-1', clientId: 'client-a' }],
				}
			},
			revokeGrant: async (grantId: string) => {
				revokedGrantIds.push(grantId)
			},
		},
	} as unknown as Env)

	const unknown = await handler.handler(confirmRequest('d'.repeat(64)))
	expect(unknown.status).toBe(400)
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({ reason: 'invalid_token' }),
	)

	const response = await handler.handler(confirmRequest(token))
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ ok: true })
	expect(revokedGrantIds).toEqual(['grant-1'])

	const rows = (
		await store.pg.query<{ id: number; password_hash: string }>(
			`SELECT id, password_hash FROM users ORDER BY id`,
		)
	).rows
	expect(
		await verifyPassword('brand-new-password', rows[0]!.password_hash),
	).toBe(true)
	expect(await verifyPassword('old-password-ok', rows[0]!.password_hash)).toBe(
		false,
	)
	expect(rows[1]!.password_hash).toBe(passwordHash)
	expect(
		await count(
			store,
			`SELECT COUNT(*)::int AS count FROM password_resets WHERE user_id = 1`,
		),
	).toBe(0)
	for (const table of ['passkeys', 'oauth_connections']) {
		expect(
			(
				await store.pg.query(
					`SELECT user_id::int AS user_id, COUNT(*)::int AS count FROM ${table} GROUP BY user_id`,
				)
			).rows,
		).toEqual([{ user_id: 2, count: 1 }])
	}
	expect(
		(await store.pg.query(`SELECT target FROM verifications`)).rows,
	).toEqual([{ target: '2' }])
	expect(
		await count(
			store,
			`SELECT COUNT(*)::int AS count FROM password_resets WHERE user_id = 2`,
		),
	).toBe(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'success',
			reason: 'two_factor=2;passkeys=1;oauth_connections=1',
		}),
	)
	const [, message] = mockSendCloudflareEmail.mock.calls[0]!
	expect((message as { to: string }).to).toBe(email)
	expect((message as { text: string }).text).toContain(
		'Two-factor authentication, passkeys, and linked sign-in providers were removed',
	)
})
