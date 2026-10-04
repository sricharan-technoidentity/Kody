import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'

export type McpAgentSession = {
	doId: string
}

export async function listMcpAgentSessionsForUser(
	db: SqlDatabase,
	userId: string,
) {
	const rows = await db
		.prepare(
			`SELECT do_id FROM mcp_agent_sessions
			WHERE user_id = ?
			ORDER BY do_id`,
		)
		.bind(userId)
		.all<{ do_id: string }>()
	return (rows.results ?? []).map((row) => ({ doId: row.do_id }))
}
