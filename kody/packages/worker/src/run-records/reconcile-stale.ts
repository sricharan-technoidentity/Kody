import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import { type RunRecords } from './run-log-types.ts'

/** Hourly ops lane. The operator lists owners; every heal is scoped structurally by forUser. */
export async function reconcileStaleRunRecords(input: {
	db: SqlDatabase
	records: RunRecords
	pageSize?: number
}) {
	const limit = Math.min(250, Math.max(1, input.pageSize ?? 250))
	let after = ''
	let usersVisited = 0
	let pagesVisited = 0
	// ponytail: complete fleet walk per fire; continue-as-new pages if a sweep exceeds the activity's 15-minute limit.
	for (;;) {
		const result = await input.db
			.prepare(
				'SELECT stable_user_id FROM users WHERE deleting_at IS NULL AND stable_user_id > ? ORDER BY stable_user_id LIMIT ?',
			)
			.bind(after, limit)
			.all<{ stable_user_id: string }>()
		for (const row of result.results) {
			const records = input.records.forUser(row.stable_user_id)
			let cursor: string | null = null
			do {
				// listRuns already conditionally heals stale rows with the existing surface-specific TTL and triage rules.
				const page = await records.listRuns({
					status: 'running',
					limit,
					cursor,
				})
				pagesVisited++
				cursor = page.nextCursor
			} while (cursor)
			usersVisited++
			after = row.stable_user_id
		}
		if (result.results.length < limit) break
	}
	return { usersVisited, pagesVisited }
}
