import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountSecretProvidersApiHandler } from '#app/handlers/account-secret-providers.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { enableSecretProvidersForTests } from '#mcp/secrets/secret-providers/flag.ts'
import { grantSecretProviderToPackage } from '#mcp/secrets/secret-providers/service.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const canonicalRef = `i/${itemId}/password`
const ownerEmail = 'one@example.com'
const ownerStableId = testStableUserIdFromEmail(ownerEmail)

async function seedUser(
	sqlite: Awaited<ReturnType<typeof createTestPg>>,
	input: { id: number; email: string; username: string },
) {
	const passwordHash = await createPasswordHash('test-password')
	await sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(testStableUserIdFromEmail(input.email))},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
}

async function seedPackage(
	sqlite: Awaited<ReturnType<typeof createTestPg>>,
	input: { id: string; userId: string; kodyId: string },
) {
	await pgQuery(sqlite).run(
		`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		input.id,
		input.userId,
		input.kodyId,
		input.kodyId,
		'',
		`source-${input.id}`,
	)
}

function createAppEnv(db: SqlDatabase) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SECRET_KMS: testSecretKms,
		SENTRY_ENVIRONMENT: 'test',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(handler: Handler, request: Request) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

const ownerSession: AuthSession = {
	stableUserId: ownerStableId,
	email: ownerEmail,
	rememberMe: false,
}

test('secret providers API lists grants and revokes them on the website', async () => {
	setAuthSessionSecret(testCookieSecret)
	const sqlite = await createTestPg()

	const db = createPgDatabase({
		connection: sqlite,
		role: 'kody_writer',
		userId: ownerStableId,
	})
	const env = createAppEnv(db)
	await seedUser(sqlite, { id: 1, email: ownerEmail, username: 'one' })
	await seedPackage(sqlite, {
		id: 'pkg-provider',
		userId: ownerStableId,
		kodyId: 'op',
	})
	await seedPackage(sqlite, {
		id: 'pkg-consumer',
		userId: ownerStableId,
		kodyId: 'deploy',
	})
	await pgQuery(sqlite).run(
		`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, ?, ?, ?, '{}')`,
		ownerStableId,
		'1password',
		'pkg-provider',
		'onePasswordServiceAccountToken',
	)
	await enableSecretProvidersForTests(
		createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
	)
	await grantSecretProviderToPackage({
		env,
		userId: ownerStableId,
		providerId: '1password',
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	const handler = createAccountSecretProvidersApiHandler(env)
	const cookie = await createAuthCookie(ownerSession, false)

	const listed = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	expect(listed.status).toBe(200)
	const listedPayload = (await listed.json()) as {
		ok: boolean
		grants: Array<{
			provider: string
			canonicalRef: string
			packageId: string
			kodyId: string
		}>
	}
	expect(listedPayload.ok).toBe(true)
	expect(listedPayload.grants).toEqual([
		{
			provider: '1password',
			canonicalRef,
			packageId: 'pkg-consumer',
			kodyId: 'deploy',
			createdAt: expect.any(String),
		},
	])

	const revoked = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'revoke',
				provider: '1password',
				ref: canonicalRef,
				packageId: 'pkg-consumer',
			}),
		}),
	)
	expect(revoked.status).toBe(200)

	const afterRevoke = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	const afterPayload = (await afterRevoke.json()) as {
		grants: Array<unknown>
	}
	expect(afterPayload.grants).toEqual([])
})

test('secret providers API is 404 when the flag is off', async () => {
	setAuthSessionSecret(testCookieSecret)
	const sqlite = await createTestPg()

	const db = createPgDatabase({
		connection: sqlite,
		role: 'kody_writer',
		userId: ownerStableId,
	})
	await seedUser(sqlite, { id: 1, email: ownerEmail, username: 'one' })
	const handler = createAccountSecretProvidersApiHandler(createAppEnv(db))
	const cookie = await createAuthCookie(ownerSession, false)
	const response = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	expect(response.status).toBe(404)
})
