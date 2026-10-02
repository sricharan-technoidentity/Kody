import { testSecretKms } from './fake-kms.ts'
import { createTestDb } from './test-db.ts'
import { createInMemoryUserMeterEnv } from '../user-meter.ts'

/**
 * One signed-in user's request env on the target stack: PGlite with that
 * user's RLS writer/reader, the DynamoDB UserMeter fake and the fake KMS.
 * `database.pg` is the superuser connection for seeding and assertions.
 */
export async function createUserTestEnv(options: { userId: string }) {
	const database = await createTestDb(options)
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: database.db,
		APP_DB_READER: database.reader,
		SECRET_KMS: testSecretKms,
		...meter.env,
	} as unknown as Env
	return {
		database,
		pg: database.pg,
		meter,
		env,
		[Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
	}
}

/** Insert a saved package row (superuser; bypasses RLS). */
export async function seedSavedPackage(
	pg: { query(sql: string, params?: Array<unknown>): Promise<unknown> },
	input: { id: string; userId: string; kodyId: string; name?: string },
) {
	await pg.query(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		 VALUES ($1, $2, $3, $4, '', $5)`,
		[
			input.id,
			input.userId,
			input.name ?? input.kodyId,
			input.kodyId,
			`source-${input.id}`,
		],
	)
}

/**
 * Superuser query helpers with SQLite-style `?` placeholders, for seeding and
 * asserting raw rows in tests ported from `node:sqlite` fixtures.
 */
export function pgQuery(pg: {
	query<T>(sql: string, params?: Array<unknown>): Promise<{ rows: Array<T> }>
}) {
	const toPg = (sql: string) => {
		let index = 0
		return sql.replace(/\?/g, () => `$${++index}`)
	}
	return {
		async get<T = Record<string, unknown>>(
			sql: string,
			...params: Array<unknown>
		) {
			return (await pg.query<T>(toPg(sql), params)).rows[0]
		},
		async all<T = Record<string, unknown>>(
			sql: string,
			...params: Array<unknown>
		) {
			return (await pg.query<T>(toPg(sql), params)).rows
		},
		async run(sql: string, ...params: Array<unknown>) {
			await pg.query(toPg(sql), params)
		},
	}
}
