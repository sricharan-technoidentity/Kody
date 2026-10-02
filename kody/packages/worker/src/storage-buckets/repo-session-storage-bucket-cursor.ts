/** Platform-owned singleton (created and seeded by the schema migrations). */
export async function readRepoSessionStorageBucketCursor(
	db: D1Database,
): Promise<string> {
	const row = await db
		.prepare(
			`SELECT position FROM repo_session_storage_bucket_cursor
			WHERE singleton = 1`,
		)
		.first<{ position: string }>()
	return row?.position ?? ''
}

export async function writeRepoSessionStorageBucketCursor(input: {
	db: D1Database
	position: string
	now?: Date
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE repo_session_storage_bucket_cursor
			SET position = ?, updated_at = ?
			WHERE singleton = 1`,
		)
		.bind(input.position, (input.now ?? new Date()).toISOString())
		.run()
}
