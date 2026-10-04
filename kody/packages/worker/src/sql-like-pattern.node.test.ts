import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { containsLikePattern } from './sql-like-pattern.ts'

test('PostgreSQL substring search preserves long Unicode text and treats wildcard characters literally', async () => {
	await using database = await createTestDb()
	const needle = `${'🙂'.repeat(40)}50%_off\\`
	const match = await database.pg.query<{ matched: boolean }>(
		`SELECT $1::text LIKE $2::text ESCAPE '\\' AS matched`,
		[`prefix ${needle} suffix`, containsLikePattern(needle)],
	)
	expect(match.rows[0]?.matched).toBe(true)
	const mismatch = await database.pg.query<{ matched: boolean }>(
		`SELECT $1::text LIKE $2::text ESCAPE '\\' AS matched`,
		[
			`prefix ${'🙂'.repeat(40)}50abcXoff\\ suffix`,
			containsLikePattern(needle),
		],
	)
	expect(mismatch.rows[0]?.matched).toBe(false)
})
