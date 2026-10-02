import { expect, test } from 'vitest'
import { handleOidcUserinfoRequest } from '#worker/oidc/userinfo.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

async function createUserinfoDb() {
	const database = await createTestDb()
	await database.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (1, 'test-user', 'user@example.com', 'user-stable-id', 'x', $1),
			(2, 'unverified', 'unverified@example.com', 'unverified-stable-id', 'x', NULL)`,
		[new Date(0).toISOString()],
	)
	return database
}

function createOidcEnv(overrides: Partial<Env> = {}) {
	return {
		OAUTH_PROVIDER: {
			unwrapToken: async () => ({
				scope: ['openid', 'email', 'profile'],
				grant: {
					clientId: 'client-123',
					scope: ['openid', 'email', 'profile'],
					props: {
						userId: 'user-stable-id',
						email: 'user@example.com',
						username: 'test-user',
						displayName: 'test-user',
						authTime: 1_700_000_000,
					},
				},
			}),
		},
		...overrides,
	} as unknown as Env
}

test('userinfo returns claims for verified bearer tokens and 401 without bearer', async () => {
	await using database = await createUserinfoDb()
	// The token subject's scoped reader performs the verification lookup.
	const env = createOidcEnv({
		APP_DB: database.forUser('user-stable-id').reader,
	} as unknown as Partial<Env>)
	const okResponse = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: 'Bearer demo-token' },
		}),
		env,
	)
	expect(okResponse.status).toBe(200)
	await expect(okResponse.json()).resolves.toEqual({
		sub: 'user-stable-id',
		email: 'user@example.com',
		email_verified: true,
		preferred_username: 'test-user',
	})

	const unauthorized = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo'),
		env,
	)
	expect(unauthorized.status).toBe(401)

	// Another account's scoped reader cannot see the subject's row, and an
	// unverified subject is refused even with a valid openid token.
	for (const stableUserId of ['unverified-stable-id', 'user-stable-id']) {
		const refused = await handleOidcUserinfoRequest(
			new Request('https://heykody.dev/oauth/userinfo', {
				headers: { Authorization: 'Bearer demo-token' },
			}),
			createOidcEnv({
				APP_DB: database.forUser('unverified-stable-id').reader,
				OAUTH_PROVIDER: {
					unwrapToken: async () => ({
						scope: ['openid'],
						grant: {
							clientId: 'client-123',
							scope: ['openid'],
							props: {
								userId: stableUserId,
								email:
									stableUserId === 'user-stable-id'
										? 'user@example.com'
										: 'unverified@example.com',
							},
						},
					}),
				},
			} as unknown as Partial<Env>),
		)
		expect(refused.status).toBe(401)
		await expect(refused.json()).resolves.toMatchObject({
			error_description: 'Account email is not verified.',
		})
	}
})

test('userinfo accepts POST with form access_token', async () => {
	await using database = await createUserinfoDb()
	const env = createOidcEnv({
		APP_DB: database.forUser('user-stable-id').reader,
	} as unknown as Partial<Env>)
	const response = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'access_token=demo-token',
		}),
		env,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		sub: 'user-stable-id',
	})
})

test('userinfo requires openid scope', async () => {
	const env = createOidcEnv({
		OAUTH_PROVIDER: {
			unwrapToken: async () => ({
				scope: ['email', 'profile'],
				grant: {
					clientId: 'client-123',
					scope: ['email', 'profile'],
					props: {
						userId: 'user-stable-id',
						email: 'user@example.com',
						username: 'test-user',
						displayName: 'test-user',
						authTime: 1_700_000_000,
					},
				},
			}),
		},
	} as Partial<Env>)
	const response = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: 'Bearer demo-token' },
		}),
		env,
	)
	expect(response.status).toBe(403)
	await expect(response.json()).resolves.toMatchObject({
		error: 'insufficient_scope',
	})
})

test('userinfo returns 401 when OAuth helpers are unavailable', async () => {
	const response = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: 'Bearer demo-token' },
		}),
		createOidcEnv({ OAUTH_PROVIDER: undefined } as Partial<Env>),
	)
	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toMatchObject({
		error: 'invalid_token',
	})
})
