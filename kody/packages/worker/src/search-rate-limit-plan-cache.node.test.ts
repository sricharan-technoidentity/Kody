import { createTestDb } from '#worker/test-support/aws/test-db.ts'

import { expect, test } from 'vitest'

import { consumeSearchRateLimit } from './search-rate-limit.ts'

const stableUserId = 'ab'.repeat(32)

test('back-to-back searches resolve the rate-limit plan from the hot-path cache', async () => {
	await using database = await createTestDb({ userId: stableUserId })
	const sqlite = database.pg

	const db = database.db
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan)
			VALUES ('cached', 'cached@example.com', 'x', ?, 'standard')`,
		)
		.bind(stableUserId)
		.run()
	const statements: Array<string> = []
	const counted = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					statements.push(query)
					return target.prepare(query)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})

	const input = {
		db: counted,
		userId: stableUserId,
		email: 'cached@example.com',
	}
	expect(await consumeSearchRateLimit(input)).toBe('standard')
	expect(await consumeSearchRateLimit(input)).toBe('standard')
	expect(
		statements.filter((query) => /\bFROM users\b/i.test(query)),
	).toHaveLength(1)
})
