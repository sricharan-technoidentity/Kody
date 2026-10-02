import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

export type PermissionRow = {
	role_name: string
	action: string | null
	entity: string | null
	access: string | null
}

function formatPermissionString(row: {
	action: string
	entity: string
	access: string
}): PermissionString {
	return `${row.action}:${row.entity}:${row.access}` as PermissionString
}

export function parseUserRolesAndPermissionRows(
	rows: Array<PermissionRow> | null | undefined,
): { roles: Array<RoleName>; permissions: Array<PermissionString> } {
	const roleSet = new Set<RoleName>()
	const permissionSet = new Set<PermissionString>()
	for (const row of rows ?? []) {
		if (row.role_name === 'user' || row.role_name === 'admin') {
			roleSet.add(row.role_name)
		}
		const { action, entity, access } = row
		if (action && entity && access) {
			permissionSet.add(formatPermissionString({ action, entity, access }))
		}
	}

	return {
		roles: Array.from(roleSet).sort(),
		permissions: Array.from(permissionSet).sort(),
	}
}

export async function getUserRolesAndPermissions(
	db: SqlDatabase,
	userId: number,
): Promise<{ roles: Array<RoleName>; permissions: Array<PermissionString> }> {
	// LEFT JOIN permissions so role membership still resolves when a role has
	// no permission rows yet (background package callers need roles for admin
	// capability discovery and execute-time checks).
	const result = await db
		.prepare(
			`SELECT DISTINCT r.name AS role_name, p.action, p.entity, p.access
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 LEFT JOIN permissions p ON p.id = rp.permission_id
			 WHERE ur.user_id = ?`,
		)
		.bind(userId)
		.all<PermissionRow>()

	return parseUserRolesAndPermissionRows(result.results)
}

function isMissingRbacTableError(error: unknown) {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return (
		message.includes('no such table: user_roles') ||
		message.includes('no such table: roles')
	)
}

/**
 * List stable user ids for every user holding the admin role. Returns an empty
 * list on pre-RBAC databases so callers can treat "no RBAC tables" as "no admins".
 */
export async function listAdminStableUserIds(
	db: SqlDatabase,
): Promise<Array<string>> {
	try {
		const result = await db
			.prepare(
				`SELECT DISTINCT u.stable_user_id
				 FROM users u
				 INNER JOIN user_roles ur ON ur.user_id = u.id
				 INNER JOIN roles r ON r.id = ur.role_id
				 WHERE r.name = 'admin'`,
			)
			.all<{ stable_user_id: string }>()
		return [...new Set((result.results ?? []).map((row) => row.stable_user_id))]
	} catch (error) {
		if (isMissingRbacTableError(error)) return []
		throw error
	}
}

export async function assignUserRole(input: {
	db: SqlDatabase
	userId: number
	roleName: RoleName
}): Promise<{ assigned: boolean }> {
	const result = await input.db
		.prepare(
			`INSERT INTO user_roles (user_id, role_id)
			 SELECT ?, id FROM roles WHERE name = ?
			 ON CONFLICT (user_id, role_id) DO NOTHING`,
		)
		.bind(input.userId, input.roleName)
		.run()
	return { assigned: (result.meta?.changes ?? 0) > 0 }
}

export async function removeUserRole(input: {
	db: SqlDatabase
	userId: number
	roleName: RoleName
}) {
	await input.db
		.prepare(
			`DELETE FROM user_roles
			 WHERE user_id = ?
			   AND role_id = (SELECT id FROM roles WHERE name = ?)`,
		)
		.bind(input.userId, input.roleName)
		.run()
}

/**
 * Removes the admin role from a user only while at least one other admin
 * remains. PostgreSQL callers lock the admin role before counting in a fresh statement
 * snapshot. Legacy SQLite callers retain their single-writer DELETE check.
 */
export async function removeAdminRolePreservingLastAdmin(input: {
	db: SqlDatabase
	userId: number
}): Promise<{ removed: boolean }> {
	if (input.db.transaction) {
		return input.db.transaction(async (db) => {
			await db
				.prepare("SELECT id FROM roles WHERE name = 'admin' FOR UPDATE")
				.first()
			return deleteAdminRole(db, input.userId)
		})
	}
	return deleteAdminRole(input.db, input.userId)
}

async function deleteAdminRole(db: SqlDatabase, userId: number) {
	const result = await db
		.prepare(
			`DELETE FROM user_roles
			 WHERE user_id = ?
			   AND role_id = (SELECT id FROM roles WHERE name = 'admin')
			   AND (SELECT COUNT(DISTINCT ur.user_id)
			        FROM user_roles ur
			        INNER JOIN roles r ON r.id = ur.role_id
			        WHERE r.name = 'admin') > 1`,
		)
		.bind(userId)
		.run()
	return { removed: (result.meta?.changes ?? 0) > 0 }
}
