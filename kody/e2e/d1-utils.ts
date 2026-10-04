import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { pocControl } from '../tools/e2e-poc-state.ts'

/** Compatibility name for the remaining POC specs; executes against the server's PGlite store. */
export async function executeE2eD1Command(sql: string) {
	await pocControl('sql', { sql })
}
export async function seedUserInE2eDatabase(input: {
	email: string
	username: string
	password: string
	admin?: boolean
}) {
	await pocControl('seed', { user: input })
}
export async function assignRoleInE2eDatabase(email: string, role: string) {
	await executeE2eD1Command(
		`INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = ${quoteSqlString(email)} AND r.name = ${quoteSqlString(role)} ON CONFLICT DO NOTHING`,
	)
}
export async function clearAuthRateLimitsInE2eDatabase() {
	await executeE2eD1Command(
		"DELETE FROM _rate_limits WHERE key LIKE 'auth:ip:%'",
	)
}
export async function deleteUserInE2eDatabase(email: string) {
	await executeE2eD1Command(
		`DELETE FROM users WHERE email = ${quoteSqlString(email)}`,
	)
}
