import { createTestDb } from './test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'

export async function createTestFeatureFlagsDb(
	input: {
		users?: Array<{
			id: number
			username: string
			stable_user_id?: string
			experiments_opt_in?: number
		}>
		globals?: Array<{
			key: string
			enabled: number
			rollout_percent: number | null
			audience: string
			note: string
			updated_by: number | null
			updated_at: string
		}>
		overrides?: Array<{
			flag_key: string
			user_id: number
			enabled: number
			updated_by: number | null
			updated_at: string
		}>
	} = {},
) {
	const database = await createTestDb()
	try {
		const users = new Map<number, NonNullable<typeof input.users>[number]>(
			Array.from(
				{ length: 9 },
				(_, index) =>
					[
						index + 1,
						{ id: index + 1, username: `user-${index + 1}` },
					] as const,
			),
		)
		for (const user of input.users ?? []) users.set(user.id, user)
		for (const row of users.values()) {
			await database.pg.query(
				'INSERT INTO users (id, username, email, stable_user_id, password_hash, experiments_opt_in) VALUES ($1, $2, $3, $4, $5, $6)',
				[
					row.id,
					row.username,
					`${row.username}@example.test`,
					row.stable_user_id ?? `stable-${row.id}`,
					'x',
					row.experiments_opt_in ?? 0,
				],
			)
		}
		for (const row of input.globals ?? [])
			await database.pg.query(
				'INSERT INTO feature_flags (key, enabled, rollout_percent, audience, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
				[
					row.key,
					row.enabled,
					row.rollout_percent,
					row.audience,
					row.note,
					row.updated_by,
					row.updated_at,
				],
			)
		for (const row of input.overrides ?? [])
			await database.pg.query(
				'INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)',
				[
					row.flag_key,
					row.user_id,
					row.enabled,
					row.updated_by,
					row.updated_at,
				],
			)
		return {
			...createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
			forUser: database.forUser,
			[Symbol.asyncDispose]: database[Symbol.asyncDispose],
		}
	} catch (error) {
		await database[Symbol.asyncDispose]()
		throw error
	}
}
