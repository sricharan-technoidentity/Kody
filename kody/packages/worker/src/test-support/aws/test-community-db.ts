import { createPgDatabase, type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from './test-db.ts'

function recordQueries(db: PgDatabase, queries: Array<string>): PgDatabase {
	return {
		...db,
		prepare(sql: string) {
			queries.push(sql.replace(/\s+/g, ' ').trim())
			return db.prepare(sql)
		},
	}
}

/**
 * Community roles on one PGlite schema: each user's scoped writer (`owner`),
 * the read-only public `kody_community` role (`community`, with captured SQL)
 * and the moderation `kody_admin` role (`admin`). `pg` seeds fixtures directly.
 */
export async function createTestCommunityDb() {
	const database = await createTestDb()
	const queries: Array<string> = []
	return {
		...database,
		queries,
		owner: (userId: string) => database.forUser(userId).db,
		community: recordQueries(
			createPgDatabase({ connection: database.pg, role: 'kody_community' }),
			queries,
		),
		admin: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
	}
}

export type TestCommunityDb = Awaited<ReturnType<typeof createTestCommunityDb>>
