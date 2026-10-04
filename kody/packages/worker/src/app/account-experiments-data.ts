import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { type AccountExperimentsLoaderData } from '#universal/loader-data.ts'

export async function readExperimentsOptIn(
	db: SqlDatabase,
	userId: number,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT experiments_opt_in FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ experiments_opt_in: number }>()
	return row?.experiments_opt_in === 1
}

export async function setExperimentsOptIn(
	db: SqlDatabase,
	input: { userId: number; enabled: boolean },
): Promise<void> {
	await db
		.prepare(
			`UPDATE users
			 SET experiments_opt_in = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?`,
		)
		.bind(input.enabled ? 1 : 0, input.userId)
		.run()
}

export async function loadAccountExperimentsData(input: {
	db: SqlDatabase
	userId: number
}): Promise<AccountExperimentsLoaderData> {
	return {
		ok: true,
		experimentsOptIn: await readExperimentsOptIn(input.db, input.userId),
	}
}
