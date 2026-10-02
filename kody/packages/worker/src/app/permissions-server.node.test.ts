import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import {
	assignUserRole,
	getUserRolesAndPermissions,
	removeUserRole,
} from '#worker/identity/permissions-db.ts'
import {
	requireUserWithPermission,
	requireUserWithRole,
} from '#app/permissions-server.ts'
import {
	type PermissionString,
	type RoleName,
	userHasPermission,
	userHasRole,
} from '#universal/permissions.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('userHasPermission and userHasRole perform pure membership checks', () => {
	const user = {
		roles: ['user', 'admin'] as Array<RoleName>,
		permissions: ['read:user:own', 'read:user:any'] as Array<PermissionString>,
	}
	expect(userHasPermission(user, 'read:user:any')).toBe(true)
	expect(userHasPermission(user, 'delete:role:any')).toBe(false)
	expect(userHasRole(user, 'admin')).toBe(true)
	expect(userHasRole(user, 'user')).toBe(true)
})

test('requireUserWithPermission and requireUserWithRole enforce auth and authorization', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: testStableUserIdFromEmail('user@example.com'),
		email: 'user@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb({ userId: session.stableUserId })
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (1, 'session-user', 'user@example.com', $1, 'unused')`,
		[session.stableUserId],
	)
	const admin = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	await assignUserRole({ db: admin, userId: 1, roleName: 'admin' })
	const authorizedEnv = {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: store.db,
	} as unknown as Env

	await expect(
		requireUserWithPermission(
			new Request('https://example.com/admin/users.json', {
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
				},
			}),
			authorizedEnv as Env,
			'read:user:any',
		),
	).resolves.toMatchObject({ userId: 1, roles: ['admin'] })

	await removeUserRole({ db: admin, userId: 1, roleName: 'admin' })
	await assignUserRole({ db: admin, userId: 1, roleName: 'user' })
	const userOnlyEnv = authorizedEnv

	await expect(
		requireUserWithPermission(
			new Request('https://example.com/admin/users.json', {
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
				},
			}),
			userOnlyEnv as Env,
			'read:user:any',
		),
	).rejects.toMatchObject({ status: 403 })

	const forbiddenHtmlResponse = await requireUserWithRole(
		new Request('https://example.com/admin/users', {
			headers: { Cookie: cookie },
		}),
		userOnlyEnv as Env,
		'admin',
	).catch((response) => response)
	expect(forbiddenHtmlResponse).toBeInstanceOf(Response)
	expect(forbiddenHtmlResponse.status).toBe(403)

	await expect(
		requireUserWithRole(
			new Request('https://example.com/admin/users.json', {
				headers: { Accept: 'application/json' },
			}),
			authorizedEnv as Env,
			'admin',
		),
	).rejects.toMatchObject({ status: 401 })

	const redirectResponse = await requireUserWithRole(
		new Request('https://example.com/admin/users'),
		authorizedEnv as Env,
		'admin',
	).catch((response) => response)
	expect(redirectResponse).toBeInstanceOf(Response)
	expect(redirectResponse.status).toBe(302)
	expect(redirectResponse.headers.get('Location')).toContain('/login')
})

test('role reads handle missing membership and roles without permission rows', async () => {
	await using store = await createTestDb({ userId: 'alice' })
	await store.pg
		.query(`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (1, 'alice', 'alice@example.com', 'alice', 'x')`)
	expect(await getUserRolesAndPermissions(store.reader, 1)).toEqual({
		roles: [],
		permissions: [],
	})
	const db = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	await assignUserRole({ db, userId: 1, roleName: 'admin' })
	await store.pg.query(
		"DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = 'admin')",
	)
	expect(await getUserRolesAndPermissions(store.reader, 1)).toEqual({
		roles: ['admin'],
		permissions: [],
	})
})
