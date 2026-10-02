import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { hashPasswordResetToken } from '#worker/identity/password-reset-tokens.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const mockModule = vi.hoisted(() => ({
	sendCloudflareEmail: vi.fn(async () => ({ ok: true })),
}))

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs getRequestIp pinned to null for deterministic audit payloads.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => null,
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mockModule.sendCloudflareEmail(...args),
}))

const { createPasswordResetRequestHandler, createPasswordResetConfirmHandler } =
	await import('./password-reset.ts')
const { runWithDeferredWork } = await import('#worker/deferred-work.ts')

// The request handler defers token creation and the email send past the
// response so latency cannot reveal whether the address is registered; tests
// collect the deferred work the way `ctx.waitUntil` does in the worker.
async function requestResetAndFlush(
	handler: ReturnType<typeof createPasswordResetRequestHandler>,
	args: { request: Request; url: URL },
) {
	const deferred = new Array<Promise<unknown>>()
	const response = await runWithDeferredWork(
		(promise) => deferred.push(promise),
		() => handler.handler({ ...args, params: {} }),
	)
	return { response, flush: () => Promise.all(deferred) }
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const ownerStableUserId = 'a'.repeat(64)
const resetToken = 'a'.repeat(64)

/** One verified account (id 123) with a live reset token, and a bystander. */
async function createResetDb() {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		 VALUES (123, 'reset-user', 'user@example.com', $1, 'unused'),
		        (124, 'bystander', 'bystander@example.com', $2, 'unused')`,
		[ownerStableUserId, 'b'.repeat(64)],
	)
	await store.pg.query(
		`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (123, $1, $2)`,
		[await hashPasswordResetToken(resetToken), Date.now() + 60_000],
	)
	return store
}

function createEnv(store: TestDb, overrides: Record<string, unknown> = {}) {
	return {
		// Signed-out requests: a writer with no account context, plus each
		// account's writer once a definer names it.
		APP_DB: store.db,
		APP_DB_FOR_USER: (stableUserId: string) => store.forUser(stableUserId).db,
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		...overrides,
	} as unknown as Env
}

async function passwordChangedAt(store: TestDb) {
	const { rows } = await store.pg.query<{ password_changed_at: string | null }>(
		`SELECT password_changed_at FROM users WHERE id = 123`,
	)
	return rows[0]?.password_changed_at ?? null
}

async function resetTokenUsers(store: TestDb) {
	const { rows } = await store.pg.query<{ user_id: number }>(
		`SELECT user_id FROM password_resets ORDER BY id`,
	)
	return rows.map((row) => Number(row.user_id))
}

function createResetRequest() {
	return new Request('https://request-origin.test/password-reset', {
		method: 'POST',
		body: JSON.stringify({ email: 'user@example.com' }),
	})
}

const hexTokenPattern = /[0-9a-f]{64}/i

test('password reset request ignores leftover website autofill and rejects the honeypot', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const handler = createPasswordResetRequestHandler(
		createEnv(store, {
			APP_BASE_URL: 'https://kody.codes',
			SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		}),
	)

	const autofilledWebsite = await requestResetAndFlush(handler, {
		request: new Request('https://kody.codes/password-reset', {
			method: 'POST',
			body: JSON.stringify({
				email: 'user@example.com',
				website: 'https://kody.codes',
			}),
		}),
		url: new URL('https://kody.codes/password-reset'),
	})
	expect(autofilledWebsite.response.status).toBe(200)
	expect(await autofilledWebsite.response.json()).toEqual({
		ok: true,
		message: 'If the account exists, a reset email has been sent.',
	})
	await autofilledWebsite.flush()

	const filledHoneypot = await requestResetAndFlush(handler, {
		request: new Request('https://kody.codes/password-reset', {
			method: 'POST',
			body: JSON.stringify({
				email: 'user@example.com',
				[honeypotFieldName]: 'https://spam.example',
			}),
		}),
		url: new URL('https://kody.codes/password-reset'),
	})
	expect(filledHoneypot.response.status).toBe(400)
	expect(await filledHoneypot.response.json()).toEqual({
		error: 'Unable to submit this form.',
	})
})

test('password reset keeps local action links on the request origin', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const handler = createPasswordResetRequestHandler(
		createEnv(store, {
			APP_BASE_URL: 'https://kody.codes',
			SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			WRANGLER_IS_LOCAL_DEV: 'true',
		}),
	)

	const { response, flush } = await requestResetAndFlush(handler, {
		request: createResetRequest(),
		url: new URL('http://localhost:3742/password-reset'),
	})

	expect(response.status).toBe(200)
	expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
	await flush()
	const [, message] = mockModule.sendCloudflareEmail.mock.calls[0]!
	expect((message as { from: string }).from).toBe('kody@kody.codes')
	expect((message as { text: string }).text).toContain(
		'http://localhost:3742/reset-password?token=',
	)
})

test('password reset sends from the sending domain when SYSTEM_EMAIL_DOMAIN overrides a legacy APP_BASE_URL', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const handler = createPasswordResetRequestHandler(
		createEnv(store, {
			APP_BASE_URL: 'https://heykody.dev',
			SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		}),
	)

	const { response, flush } = await requestResetAndFlush(handler, {
		request: createResetRequest(),
		url: new URL('https://heykody.dev/password-reset'),
	})
	await flush()

	expect(response.status).toBe(200)
	expect(mockModule.sendCloudflareEmail).toHaveBeenCalledWith(
		{
			accountId: 'account-id',
			apiBaseUrl: 'https://api.cloudflare.test',
			apiToken: 'api-token',
		},
		expect.objectContaining({
			from: 'kody@kody.codes',
			to: 'user@example.com',
		}),
	)
	const [, message] = mockModule.sendCloudflareEmail.mock.calls[0]!
	expect((message as { text: string }).text).toContain(
		'https://kody.codes/reset-password?token=',
	)
	expect((message as { html: string }).html).not.toContain('heykody.dev')
})

test('password reset sends from the APP_BASE_URL hostname without logging the token', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const handler = createPasswordResetRequestHandler(
		createEnv(store, { APP_BASE_URL: 'https://app.example.com/path' }),
	)

	try {
		const { response, flush } = await requestResetAndFlush(handler, {
			request: createResetRequest(),
			url: new URL('https://request-origin.test/password-reset'),
		})
		await flush()

		expect(response.status).toBe(200)
		expect(mockModule.sendCloudflareEmail).toHaveBeenCalledWith(
			{
				accountId: 'account-id',
				apiBaseUrl: 'https://api.cloudflare.test',
				apiToken: 'api-token',
			},
			expect.objectContaining({
				from: 'kody@app.example.com',
				to: 'user@example.com',
			}),
		)
		const [, message] = mockModule.sendCloudflareEmail.mock.calls[0]!
		expect((message as { text: string }).text).toContain(
			'https://app.example.com/reset-password?token=',
		)
		for (const args of warnSpy.mock.calls) {
			const joined = args.map(String).join(' ')
			expect(joined).not.toContain('token=')
			expect(joined).not.toMatch(hexTokenPattern)
		}
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'auth',
				action: 'password_reset_request',
				result: 'success',
			}),
		)
	} finally {
		warnSpy.mockRestore()
	}
})

test('password reset skips sending when APP_BASE_URL is missing and logs a redacted payload', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const handler = createPasswordResetRequestHandler(
		createEnv(store, { APP_BASE_URL: '' }),
	)

	try {
		const { response, flush } = await requestResetAndFlush(handler, {
			request: createResetRequest(),
			url: new URL('https://request-origin.test/password-reset'),
		})
		await flush()

		expect(response.status).toBe(200)
		expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(
			'password-reset-email-sender-unconfigured',
			expect.any(String),
		)

		const warnCalls = warnSpy.mock.calls
		const emailMissingCall = warnCalls.find(
			(args) => args[0] === 'password-reset-email-sender-unconfigured',
		)
		expect(emailMissingCall).toBeDefined()

		const logPayload = emailMissingCall![1] as string
		expect(logPayload).not.toContain('token=')
		expect(logPayload).not.toMatch(hexTokenPattern)
		expect(logPayload).not.toContain('user@example.com')
		expect(logPayload).not.toContain('<html')
		expect(logPayload).not.toContain('reset-password')

		const parsed = JSON.parse(logPayload) as Record<string, unknown>
		expect(parsed).toHaveProperty('subject')
		expect(parsed.to).toBe('***@example.com')
	} finally {
		warnSpy.mockRestore()
	}
})

function createTrackingGrantHelpers(
	initialGrants: Array<{ id: string; clientId: string }>,
) {
	const revokedGrantIds = new Array<string>()
	const liveGrants = [...initialGrants]
	return {
		revokedGrantIds,
		liveGrants,
		helpers: {
			listUserGrants: vi.fn(async () => ({
				items: liveGrants.filter(
					(grant) => !revokedGrantIds.includes(grant.id),
				),
			})),
			revokeGrant: vi.fn(async (grantId: string) => {
				revokedGrantIds.push(grantId)
			}),
		},
	}
}

test('password reset confirm revokes MCP grants before stamping password_changed_at', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const { helpers, revokedGrantIds } = createTrackingGrantHelpers([
		{ id: 'grant-1', clientId: 'client-a' },
		{ id: 'grant-2', clientId: 'client-b' },
	])
	const handler = createPasswordResetConfirmHandler(
		createEnv(store, {
			OAUTH_PROVIDER: helpers,
			APP_BASE_URL: 'https://kody.codes',
			SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		}),
	)

	const response = await handler.handler({
		request: new Request('https://example.com/password-reset/confirm', {
			method: 'POST',
			body: JSON.stringify({
				token: resetToken,
				password: 'new-password-123',
			}),
		}),
		url: new URL('https://example.com/password-reset/confirm'),
		params: {},
	})

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ ok: true })
	expect(helpers.listUserGrants).toHaveBeenCalledWith(ownerStableUserId, {
		cursor: undefined,
	})
	expect(revokedGrantIds).toEqual(['grant-1', 'grant-2'])
	expect(await passwordChangedAt(store)).toEqual(expect.any(String))
	// The owner's reset tokens are consumed; the bystander has none to lose.
	expect(await resetTokenUsers(store)).toEqual([])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'success',
			reason: 'two_factor=0;passkeys=0;oauth_connections=0',
		}),
	)
	const [, confirmMessage] = mockModule.sendCloudflareEmail.mock.calls[0]!
	expect((confirmMessage as { to: string }).to).toBe('user@example.com')
	expect((confirmMessage as { from: string }).from).toBe('kody@kody.codes')
	expect((confirmMessage as { text: string }).text).toContain(
		'Two-factor authentication, passkeys, and linked sign-in providers were removed',
	)
})

test('password reset confirm revokes a grant created between first revoke and password_changed_at', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const { helpers, revokedGrantIds, liveGrants } = createTrackingGrantHelpers([
		{ id: 'grant-a', clientId: 'client-a' },
	])
	// A grant minted while the first revoke pass runs shows up only in the
	// re-list after password_changed_at is stamped.
	helpers.revokeGrant.mockImplementationOnce(async (grantId: string) => {
		revokedGrantIds.push(grantId)
		liveGrants.push({ id: 'grant-raced', clientId: 'client-b' })
	})
	const handler = createPasswordResetConfirmHandler(
		createEnv(store, {
			OAUTH_PROVIDER: helpers,
			APP_BASE_URL: 'https://kody.codes',
			SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		}),
	)

	const response = await handler.handler({
		request: new Request('https://example.com/password-reset/confirm', {
			method: 'POST',
			body: JSON.stringify({
				token: resetToken,
				password: 'new-password-123',
			}),
		}),
		url: new URL('https://example.com/password-reset/confirm'),
		params: {},
	})

	expect(response.status).toBe(200)
	expect(revokedGrantIds).toEqual(['grant-a', 'grant-raced'])
	expect(await passwordChangedAt(store)).toEqual(expect.any(String))
	expect(await resetTokenUsers(store)).toEqual([])
})

test('password reset confirm fails closed when MCP grants cannot be revoked', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const handler = createPasswordResetConfirmHandler(
		createEnv(store, {
			OAUTH_PROVIDER: {
				listUserGrants: async () => ({
					items: [{ id: 'grant-1', clientId: 'client-a' }],
				}),
				revokeGrant: async () => {
					throw new Error('kv unavailable')
				},
			},
		}),
	)

	const response = await handler.handler({
		request: new Request('https://example.com/password-reset/confirm', {
			method: 'POST',
			body: JSON.stringify({
				token: resetToken,
				password: 'new-password-123',
			}),
		}),
		url: new URL('https://example.com/password-reset/confirm'),
		params: {},
	})

	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		error: 'Unable to finish password reset right now.',
	})
	expect(await passwordChangedAt(store)).toBeNull()
	expect(await resetTokenUsers(store)).toEqual([123])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			reason: 'kv unavailable',
		}),
	)
})

test('password reset request mints the token on the address owner only and is silent for unknown addresses', async () => {
	vi.clearAllMocks()
	await using store = await createResetDb()
	const handler = createPasswordResetRequestHandler(
		createEnv(store, { APP_BASE_URL: '' }),
	)
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		for (const email of ['user@example.com', 'nobody@example.com']) {
			const { response, flush } = await requestResetAndFlush(handler, {
				request: new Request('https://kody.codes/password-reset', {
					method: 'POST',
					body: JSON.stringify({ email }),
				}),
				url: new URL('https://kody.codes/password-reset'),
			})
			await flush()
			expect(await response.json()).toEqual({
				ok: true,
				message: 'If the account exists, a reset email has been sent.',
			})
		}
	} finally {
		warnSpy.mockRestore()
	}
	// The owner's seeded token was replaced by a fresh one; nothing else was written.
	const { rows } = await store.pg.query<{
		user_id: number
		token_hash: string
	}>(`SELECT user_id, token_hash FROM password_resets`)
	expect(rows).toEqual([
		{
			user_id: 123,
			token_hash: expect.not.stringMatching(
				await hashPasswordResetToken(resetToken),
			),
		},
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'password_reset_request',
			result: 'failure',
			reason: 'email_not_found',
		}),
	)
})
