import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'
import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountPasskeysApiHandler } from '#app/handlers/account-passkeys.ts'
import {
	createWebauthnAuthenticationHandler,
	createWebauthnRegistrationHandler,
} from '#app/handlers/webauthn.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedUser(
	store: TestDb,
	input: {
		id: number
		email: string
		username: string
	},
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ($1, $2, $3, $4, 'test-password-hash', '2026-01-01T00:00:00.000Z')`,
		[input.id, input.username, input.email, stableUserId],
	)
	return stableUserId
}

async function seedPasskey(
	store: TestDb,
	input: {
		id: string
		userId: number
		name?: string
		aaguid?: string
		lastUsedAt?: string | null
		publicKey?: string
	},
) {
	await store.pg.query(
		`INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name, last_used_at
		) VALUES ($1, $2, $3, $4, 'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', $5, $6)`,
		[
			input.id,
			input.aaguid ?? '00000000-0000-0000-0000-000000000000',
			input.publicKey ?? 'cHVibGljLWtleQ',
			input.userId,
			input.name ?? '',
			input.lastUsedAt ?? null,
		],
	)
}

/** A software P-256 authenticator that signs WebAuthn assertions for example.com. */
function createTestAuthenticator() {
	const { privateKey, publicKey } = generateKeyPairSync('ec', {
		namedCurve: 'P-256',
	})
	const jwk = publicKey.export({ format: 'jwk' })
	const coseKey = isoCBOR.encode(
		new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, isoBase64URL.toBuffer(jwk.x!)],
			[-3, isoBase64URL.toBuffer(jwk.y!)],
		]),
	)
	return {
		publicKey: isoBase64URL.fromBuffer(coseKey),
		assert(input: { id: string; challenge: string; counter: number }) {
			const clientDataJSON = Buffer.from(
				JSON.stringify({
					type: 'webauthn.get',
					challenge: input.challenge,
					origin: 'http://example.com',
				}),
			)
			const counter = Buffer.alloc(4)
			counter.writeUInt32BE(input.counter)
			// rpIdHash, flags (user present + user verified), sign counter.
			const authenticatorData = Buffer.concat([
				createHash('sha256').update('example.com').digest(),
				Buffer.from([0x05]),
				counter,
			])
			const signature = sign(
				'sha256',
				Buffer.concat([
					authenticatorData,
					createHash('sha256').update(clientDataJSON).digest(),
				]),
				privateKey,
			)
			return {
				id: input.id,
				rawId: input.id,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: clientDataJSON.toString('base64url'),
					authenticatorData: authenticatorData.toString('base64url'),
					signature: signature.toString('base64url'),
				},
			}
		},
	}
}

function createAppEnv(db: PgDatabase, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Parameters<typeof createAccountPasskeysApiHandler>[0]
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(
	handler: Handler,
	request: Request,
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

function initTestSecrets() {
	setAuthSessionSecret(testCookieSecret)
}

const userOneSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('one@example.com'),
	email: 'one@example.com',
	rememberMe: false,
}

test('account passkeys API lists labels/dates, renames owned keys, and deletes while ignoring other users', async () => {
	initTestSecrets()
	await using store = await createTestDb()
	const userOneId = await seedUser(store, {
		id: 1,
		email: 'one@example.com',
		username: 'one',
	})
	await seedUser(store, { id: 2, email: 'two@example.com', username: 'two' })
	await seedPasskey(store, {
		id: 'passkey-user-1',
		userId: 1,
		aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
		lastUsedAt: '2026-07-01 12:00:00',
	})
	await seedPasskey(store, {
		id: 'passkey-user-1b',
		userId: 1,
		name: 'Work laptop',
	})
	await seedPasskey(store, {
		id: 'passkey-user-2',
		userId: 2,
		name: 'Other user',
	})

	const handler = createAccountPasskeysApiHandler(
		createAppEnv(store.forUser(userOneId).db),
	)
	const listResponse = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			headers: { Cookie: await createAuthCookie(userOneSession, false) },
		}),
	)
	expect(listResponse.status).toBe(200)
	const listPayload = (await listResponse.json()) as {
		ok: boolean
		passkeys: Array<{
			id: string
			name: string
			createdAt: string
			lastUsedAt: string | null
		}>
	}
	expect(listPayload.ok).toBe(true)
	expect(listPayload.passkeys.map((passkey) => passkey.id)).toEqual([
		'passkey-user-1b',
		'passkey-user-1',
	])
	expect(listPayload.passkeys).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'passkey-user-1',
				name: 'Google Password Manager',
				lastUsedAt: '2026-07-01 12:00:00',
			}),
			expect.objectContaining({
				id: 'passkey-user-1b',
				name: 'Work laptop',
				lastUsedAt: null,
			}),
		]),
	)

	const crossUserRename = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'rename',
				passkeyId: 'passkey-user-2',
				name: 'Stolen name',
			}),
		}),
	)
	expect(crossUserRename.status).toBe(404)
	expect(
		(
			await store.pg.query(
				`SELECT name FROM passkeys WHERE id = 'passkey-user-2'`,
			)
		).rows,
	).toEqual([{ name: 'Other user' }])

	const ownRename = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'rename',
				passkeyId: 'passkey-user-1',
				name: '  Phone · Google  ',
			}),
		}),
	)
	expect(ownRename.status).toBe(200)
	const renamePayload = (await ownRename.json()) as {
		ok: boolean
		passkeys: Array<{ id: string; name: string }>
	}
	expect(renamePayload.ok).toBe(true)
	expect(
		renamePayload.passkeys.find((passkey) => passkey.id === 'passkey-user-1')
			?.name,
	).toBe('Phone · Google')

	const invalidRename = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				intent: 'rename',
				passkeyId: 'passkey-user-1',
				name: '   ',
			}),
		}),
	)
	expect(invalidRename.status).toBe(400)

	const crossUserDelete = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'delete', passkeyId: 'passkey-user-2' }),
		}),
	)
	expect(crossUserDelete.status).toBe(404)
	expect(
		(await store.pg.query(`SELECT COUNT(*)::int AS count FROM passkeys`)).rows,
	).toEqual([{ count: 3 }])

	const ownDelete = await runHandler(
		handler,
		new Request('http://example.com/account/passkeys.json', {
			method: 'POST',
			headers: {
				Cookie: await createAuthCookie(userOneSession, false),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'delete', passkeyId: 'passkey-user-1' }),
		}),
	)
	expect(ownDelete.status).toBe(200)
	const deletePayload = (await ownDelete.json()) as {
		ok: boolean
		passkeys: Array<{ id: string }>
	}
	expect(deletePayload.ok).toBe(true)
	expect(deletePayload.passkeys.map((passkey) => passkey.id)).toEqual([
		'passkey-user-1b',
	])
})

test('registration options require authentication and exclude existing credentials', async () => {
	initTestSecrets()
	await using store = await createTestDb()
	const unauthenticated = await runHandler(
		createWebauthnRegistrationHandler(createAppEnv(store.forUser().db)),
		new Request('http://example.com/webauthn/registration'),
	)
	expect(unauthenticated.status).toBe(401)

	const userOneId = await seedUser(store, {
		id: 1,
		email: 'one@example.com',
		username: 'one',
	})
	await seedUser(store, { id: 2, email: 'two@example.com', username: 'two' })
	await seedPasskey(store, { id: 'passkey-user-1', userId: 1 })
	await seedPasskey(store, { id: 'passkey-user-2', userId: 2 })
	const handler = createWebauthnRegistrationHandler(
		createAppEnv(store.forUser(userOneId).db),
	)

	const response = await runHandler(
		handler,
		new Request('http://example.com/webauthn/registration', {
			headers: { Cookie: await createAuthCookie(userOneSession, false) },
		}),
	)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		ok: boolean
		options: {
			challenge: string
			rp: { id: string }
			excludeCredentials: Array<{ id: string }>
		}
	}
	expect(payload.ok).toBe(true)
	expect(payload.options.rp.id).toBe('example.com')
	expect(payload.options.challenge.length).toBeGreaterThan(0)
	expect(payload.options.excludeCredentials).toEqual([
		expect.objectContaining({ id: 'passkey-user-1' }),
	])
	expect(response.headers.get('Set-Cookie')).toContain(
		'kody_webauthn_challenge=',
	)
})

test('signed-out passkey sign-in resolves the credential owner and requires their key', async () => {
	initTestSecrets()
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'one@example.com',
		username: 'one',
	})
	await seedUser(store, { id: 2, email: 'two@example.com', username: 'two' })
	const authenticator = createTestAuthenticator()
	const credentialId = isoBase64URL.fromUTF8String('passkey-user-1')
	await seedPasskey(store, {
		id: credentialId,
		userId: 1,
		publicKey: authenticator.publicKey,
	})
	await seedPasskey(store, { id: 'passkey-user-2', userId: 2 })
	// Pre-auth writer: no account context, so RLS shows it no passkeys.
	const handler = createWebauthnAuthenticationHandler(
		createAppEnv(store.forUser().db, {
			APP_DB_FOR_USER: (userId: string) => store.forUser(userId).db,
		}),
	)

	async function startCeremony() {
		const response = await runHandler(
			handler,
			new Request('http://example.com/webauthn/authentication'),
		)
		expect(response.status).toBe(200)
		const payload = (await response.json()) as {
			ok: boolean
			options: { challenge: string }
		}
		expect(payload.ok).toBe(true)
		expect(payload.options.challenge.length).toBeGreaterThan(0)
		const cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? ''
		expect(cookie).toContain('kody_webauthn_challenge=')
		return { challenge: payload.options.challenge, cookie }
	}
	function submit(cookie: string, response: unknown) {
		return runHandler(
			handler,
			new Request('http://example.com/webauthn/authentication', {
				method: 'POST',
				headers: { Cookie: cookie, 'Content-Type': 'application/json' },
				body: JSON.stringify({ response }),
			}),
		)
	}

	const unknown = await submit((await startCeremony()).cookie, {
		id: 'unknown-passkey',
		rawId: 'unknown-passkey',
	})
	expect(unknown.status).toBe(401)
	expect(await unknown.json()).toMatchObject({
		ok: false,
		error: 'Passkey not recognized.',
	})

	await expect(
		store
			.forUser()
			.reader.prepare(`SELECT kody_passkey_owner(?) AS owner`)
			.bind(credentialId)
			.first(),
	).rejects.toThrow(/permission denied/)

	// Knowing the credential id is not enough: another key's signature fails.
	const forged = await startCeremony()
	const forgedResponse = await submit(
		forged.cookie,
		createTestAuthenticator().assert({
			id: credentialId,
			challenge: forged.challenge,
			counter: 1,
		}),
	)
	expect(forgedResponse.status).toBe(401)
	expect(await forgedResponse.json()).toMatchObject({
		ok: false,
		error: 'Passkey sign-in failed.',
	})

	const ceremony = await startCeremony()
	const response = await submit(
		ceremony.cookie,
		authenticator.assert({
			id: credentialId,
			challenge: ceremony.challenge,
			counter: 1,
		}),
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ ok: true })
	expect(response.headers.getSetCookie()).toEqual(
		expect.arrayContaining([expect.stringMatching(/^kody_session=[^;]+/)]),
	)
	expect(
		(
			await store.pg.query<{
				id: string
				counter: number
				last_used_at: string | null
			}>(
				`SELECT id, counter::int AS counter, last_used_at FROM passkeys ORDER BY user_id`,
			)
		).rows,
	).toEqual([
		{
			id: credentialId,
			counter: 1,
			last_used_at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
		},
		{ id: 'passkey-user-2', counter: 0, last_used_at: null },
	])
	expect(
		(
			await store.pg.query(
				`SELECT last_active_at IS NOT NULL AS active FROM users WHERE stable_user_id = $1`,
				[ownerId],
			)
		).rows,
	).toEqual([{ active: true }])
})
