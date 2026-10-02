import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	buildPermissionString,
	listAdminRolePermissionStrings,
	listRegistryPermissionStrings,
	listUserRolePermissionStrings,
	parsePermissionString,
	roleNames,
	type PermissionAccess,
	type PermissionAction,
	type PermissionEntity,
	type PermissionString,
} from '#universal/permissions.ts'

test('parsePermissionString splits action, entity, and access', () => {
	expect(parsePermissionString('read:user:own')).toEqual({
		action: 'read',
		entity: 'user',
		access: 'own',
	})
	expect(parsePermissionString('delete:role:any')).toEqual({
		action: 'delete',
		entity: 'role',
		access: 'any',
	})
})

test('permission registry and Postgres seed rows stay aligned', async () => {
	await using database = await createTestDb()
	const db = database.reader

	type PermissionRow = {
		action: PermissionAction
		entity: PermissionEntity
		access: PermissionAccess
	}
	const seededPermissions = (
		await db
			.prepare(`SELECT action, entity, access FROM permissions`)
			.all<PermissionRow>()
	).results.map((row) => buildPermissionString(row))
	expect(seededPermissions.sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	async function listSeededRolePermissionStrings(
		roleName: string,
	): Promise<Array<PermissionString>> {
		return (
			await db
				.prepare(
					`SELECT p.action, p.entity, p.access
					FROM role_permissions rp
					INNER JOIN roles r ON r.id = rp.role_id
					INNER JOIN permissions p ON p.id = rp.permission_id
					WHERE r.name = ?`,
				)
				.bind(roleName)
				.all<PermissionRow>()
		).results.map((row) => buildPermissionString(row))
	}

	expect((await listSeededRolePermissionStrings('user')).sort()).toEqual(
		listUserRolePermissionStrings().sort(),
	)
	expect(listUserRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings()
			.filter(
				(permission) => parsePermissionString(permission).access === 'own',
			)
			.sort(),
	)

	expect((await listSeededRolePermissionStrings('admin')).sort()).toEqual(
		listAdminRolePermissionStrings().sort(),
	)
	expect(listAdminRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	const seededRoleNames = (
		await db.prepare(`SELECT name FROM roles`).all<{ name: string }>()
	).results.map((row) => row.name)
	expect(seededRoleNames.sort()).toEqual([...roleNames].sort())
})
