import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	assignUserRole,
	getUserRolesAndPermissions,
	listAdminStableUserIds,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
} from './permissions-db.ts'

test('RBAC mutations are idempotent, require operator privileges and preserve the last admin', async () => {
	await using store = await createTestDb({ userId: 'alice' })
	await store.pg
		.query(`INSERT INTO users (id, username, email, stable_user_id, password_hash) VALUES
		(1, 'alice', 'alice@example.com', 'alice', 'x'), (2, 'bob', 'bob@example.com', 'bob', 'x')`)
	const db = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	expect(
		await assignUserRole({ db: store.db, userId: 1, roleName: 'user' }),
	).toEqual({ assigned: true })
	expect(
		await assignUserRole({ db: store.db, userId: 1, roleName: 'user' }),
	).toEqual({ assigned: false })
	await expect(
		assignUserRole({ db: store.db, userId: 1, roleName: 'admin' }),
	).rejects.toThrow('row-level security')
	await expect(
		assignUserRole({ db: store.db, userId: 2, roleName: 'user' }),
	).rejects.toThrow('row-level security')
	await expect(
		assignUserRole({ db: store.reader, userId: 1, roleName: 'admin' }),
	).rejects.toThrow('read-only transaction')
	await assignUserRole({ db, userId: 1, roleName: 'admin' })
	await assignUserRole({ db, userId: 2, roleName: 'admin' })
	expect(await getUserRolesAndPermissions(store.reader, 1)).toMatchObject({
		roles: ['admin', 'user'],
		permissions: expect.arrayContaining(['read:user:own', 'read:user:any']),
	})
	expect(await getUserRolesAndPermissions(store.reader, 2)).toEqual({
		roles: [],
		permissions: [],
	})
	expect((await listAdminStableUserIds(db)).sort()).toEqual(['alice', 'bob'])
	const results = await Promise.all(
		[1, 2].map((userId) => removeAdminRolePreservingLastAdmin({ db, userId })),
	)
	expect(results.filter(({ removed }) => removed)).toHaveLength(1)
	const remaining = await listAdminStableUserIds(db)
	expect(remaining).toHaveLength(1)
	expect(
		await removeAdminRolePreservingLastAdmin({
			db,
			userId: remaining[0] === 'alice' ? 1 : 2,
		}),
	).toEqual({ removed: false })
	await removeUserRole({ db, userId: 1, roleName: 'user' })
	expect(
		(await getUserRolesAndPermissions(store.reader, 1)).roles,
	).not.toContain('user')
})
