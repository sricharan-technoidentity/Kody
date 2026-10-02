import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from './auth-session.ts'
import {
	readAuthenticatedAppUser,
	readAuthenticatedAppUserForDeletion,
} from './authenticated-user.ts'
import {
	hasResolvedRequestFeatureFlags,
	loadRequestFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const email = 'user@example.com'
const stableUserId = testStableUserIdFromEmail(email)

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/** Account 7 plus a bystander whose row its writer must never resolve. */
async function createAuthUserDb(
	input: { username?: string; deletingAt?: string | null } = {},
) {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id, deleting_at)
		 VALUES (7, $1, $2, 'unused', $3, $4),
		        (8, 'other@example.com', 'other-user', 'unused', $5, NULL)`,
		[
			email,
			input.username ?? 'html-user',
			stableUserId,
			input.deletingAt ?? null,
			testStableUserIdFromEmail('other@example.com'),
		],
	)
	await store.pg.exec(
		`INSERT INTO user_roles (user_id, role_id) SELECT 7, id FROM roles WHERE name = 'user'`,
	)
	return store
}

function createEnv(db: PgDatabase) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
	} as unknown as Env
}

async function sessionCookie(session: Omit<AuthSession, 'rememberMe'>) {
	setAuthSessionSecret(testCookieSecret)
	return await createAuthCookie({ ...session, rememberMe: false }, false)
}

/** Counts prepares (per table) and round trips on the scoped writer. */
function countQueries(db: PgDatabase) {
	const counts = { batch: 0, flagPrepares: 0 }
	const counted: PgDatabase = {
		...db,
		prepare(sql: string) {
			if (/from feature_flag(s|_user_overrides)\b/i.test(sql)) {
				counts.flagPrepares += 1
			}
			return db.prepare(sql)
		},
		batch(statements) {
			counts.batch += 1
			return db.batch(statements)
		},
	}
	return { db: counted, counts }
}

async function userRolePermissions(store: TestDb) {
	return (
		await store.pg.query<{ permission: string }>(
			`SELECT DISTINCT p.action || ':' || p.entity || ':' || p.access AS permission
			 FROM roles r
			 JOIN role_permissions rp ON rp.role_id = r.id
			 JOIN permissions p ON p.id = rp.permission_id
			 WHERE r.name = 'user'`,
		)
	).rows.map((row) => row.permission)
}

test('readAuthenticatedAppUser only requires the session cookie secret from env', async () => {
	const user = await readAuthenticatedAppUser(
		new Request('https://example.com/account/secrets.json'),
		{
			COOKIE_SECRET: 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
		} as unknown as Env,
	)

	expect(user).toBeNull()
})

test('readAuthenticatedAppUser resolves only the account its own writer can see', async () => {
	await using store = await createAuthUserDb()
	const request = (cookie: string) =>
		new Request('https://example.com/account/profile.json', {
			headers: { Cookie: cookie },
		})

	// No such account.
	const unknownId = 'f'.repeat(64)
	await expect(
		readAuthenticatedAppUser(
			request(await sessionCookie({ stableUserId: unknownId, email })),
			createEnv(store.forUser(unknownId).db),
		),
	).resolves.toBeNull()

	// A cookie naming account 7 on another account's writer: RLS hides the row.
	await expect(
		readAuthenticatedAppUser(
			request(await sessionCookie({ stableUserId, email })),
			createEnv(
				store.forUser(testStableUserIdFromEmail('other@example.com')).db,
			),
		),
	).resolves.toBeNull()

	const user = await readAuthenticatedAppUser(
		request(await sessionCookie({ stableUserId, email })),
		createEnv(store.forUser(stableUserId).db),
	)
	expect(user).toMatchObject({
		userId: 7,
		username: 'html-user',
		email,
		roles: ['user'],
		mcpUser: { userId: stableUserId },
		artifactOwnerIds: [stableUserId],
	})
	expect(new Set(user?.permissions)).toEqual(
		new Set(await userRolePermissions(store)),
	)
})

test('readAuthenticatedAppUser fails closed to empty roles when the rbac query errors', async () => {
	await using store = await createAuthUserDb({ username: 'resilient-user' })
	// The roles read fails; the user row still resolves through the fallback.
	await store.pg.exec(`REVOKE SELECT ON user_roles FROM kody_writer`)
	const cookie = await sessionCookie({ stableUserId, email })

	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)
	try {
		const user = await readAuthenticatedAppUser(
			new Request('https://example.com/session', {
				headers: { Cookie: cookie },
			}),
			createEnv(store.forUser(stableUserId).db),
		)

		expect(user).not.toBeNull()
		expect(user?.username).toBe('resilient-user')
		expect(user?.roles).toEqual([])
		expect(user?.permissions).toEqual([])
		expect(consoleError).toHaveBeenCalled()
	} finally {
		consoleError.mockRestore()
	}
})

test('deleting accounts are invalid for normal requests but can retry deletion', async () => {
	await using store = await createAuthUserDb({
		username: 'deleting-user',
		deletingAt: '2026-07-22 22:00:00',
	})
	const cookie = await sessionCookie({ stableUserId, email })
	const env = createEnv(store.forUser(stableUserId).db)
	const request = () =>
		new Request('https://example.com/account/delete', {
			headers: { Cookie: cookie },
		})
	await expect(readAuthenticatedAppUser(request(), env)).resolves.toBeNull()
	await expect(
		readAuthenticatedAppUserForDeletion(request(), env),
	).resolves.toEqual(
		expect.objectContaining({
			userId: 7,
			username: 'deleting-user',
		}),
	)
})

test('readAuthenticatedAppUser prefetches flags only when HTML pages opt in', async () => {
	await using store = await createAuthUserDb()
	const cookie = await sessionCookie({ stableUserId, email })
	const { db, counts } = countQueries(store.forUser(stableUserId).db)
	const env = createEnv(db)

	const apiRequest = new Request('https://example.com/account/connections', {
		headers: { Cookie: cookie },
	})
	const apiUser = await readAuthenticatedAppUser(apiRequest, env)
	expect(apiUser?.username).toBe('html-user')
	expect(hasResolvedRequestFeatureFlags(apiRequest)).toBe(false)
	// API-style: user+roles only. No Accept/path heuristic can start flags.
	expect(counts.flagPrepares).toBe(0)
	expect(counts.batch).toBe(1)

	const htmlRequest = new Request('https://example.com/', {
		headers: { Cookie: cookie },
	})
	const htmlUser = await readAuthenticatedAppUser(htmlRequest, env, {
		prefetchFeatureFlags: true,
	})
	expect(htmlUser?.username).toBe('html-user')
	expect(htmlUser).not.toBeNull()
	if (!htmlUser) throw new Error('expected authenticated html user')
	expect(hasResolvedRequestFeatureFlags(htmlRequest)).toBe(true)
	// HTML opt-in adds one user+roles batch and one flags batch (total 3).
	expect(counts.flagPrepares).toBe(2)
	expect(counts.batch).toBe(3)

	await loadRequestFeatureFlags(htmlRequest, env, {
		userId: htmlUser.userId,
		stableUserId: htmlUser.mcpUser.userId,
	})
	expect(counts.flagPrepares).toBe(2)
	expect(counts.batch).toBe(3)
})
