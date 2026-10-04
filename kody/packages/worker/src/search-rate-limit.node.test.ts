import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'

import { expect, test, vi } from 'vitest'

import { getCachedUserPlan } from '#worker/entitlements/service.ts'
import {
	consumeSearchRateLimit,
	isSearchRateLimitError,
	searchBurstRateLimitKey,
	searchDailyRateLimitKey,
	searchRateLimitByPlan,
	SearchRateLimitError,
} from './search-rate-limit.ts'

vi.mock('#worker/entitlements/service.ts', () => ({
	getCachedUserPlan: vi.fn(async () => 'free'),
}))

async function createDb() {
	const database = await createTestDb()
	const sqlite = database.pg
	const db = database.db
	return { sqlite, db, [Symbol.asyncDispose]: database[Symbol.asyncDispose] }
}

test('consumeSearchRateLimit returns the resolved plan so search does not look it up again', async () => {
	await using harness = await createDb()
	const { db } = harness
	vi.mocked(getCachedUserPlan).mockClear()
	vi.mocked(getCachedUserPlan).mockResolvedValueOnce('pro')
	expect(
		await consumeSearchRateLimit({
			db,
			userId: 'user-search-plan',
			email: 'plan@example.com',
		}),
	).toBe('pro')
	expect(getCachedUserPlan).toHaveBeenCalledTimes(1)
})

test('consumeSearchRateLimit no-ops without a userId', async () => {
	await using harness = await createDb()
	const { sqlite, db } = harness
	expect(
		await consumeSearchRateLimit({
			db,
			userId: null,
			email: null,
		}),
	).toBe('free')
	expect(
		await pgQuery(sqlite).get(`SELECT key FROM _rate_limits LIMIT 1`),
	).toBeUndefined()
})

test('consumeSearchRateLimit allows searches under the free burst ceiling', async () => {
	await using harness = await createDb()
	const { db } = harness
	const limit = searchRateLimitByPlan.free.burst.maxRequests
	for (let index = 0; index < limit; index++) {
		await consumeSearchRateLimit({
			db,
			userId: 'user-search-1',
			email: 'user@example.com',
		})
	}
})

test('consumeSearchRateLimit rejects over the free burst ceiling', async () => {
	await using harness = await createDb()
	const { db } = harness
	const limit = searchRateLimitByPlan.free.burst.maxRequests
	for (let index = 0; index < limit; index++) {
		await consumeSearchRateLimit({
			db,
			userId: 'user-search-2',
			email: 'user@example.com',
		})
	}
	const error = await consumeSearchRateLimit({
		db,
		userId: 'user-search-2',
		email: 'user@example.com',
	}).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(isSearchRateLimitError(error)).toBe(true)
	expect(error).toBeInstanceOf(SearchRateLimitError)
	if (!(error instanceof SearchRateLimitError)) {
		throw new Error('expected SearchRateLimitError')
	}
	expect(error.code).toBe('rate_limited')
	expect(error.window).toBe('burst')
	expect(error.limit).toBe(limit)
	expect(error.retryAfterSeconds).toBe(
		searchRateLimitByPlan.free.burst.windowSeconds,
	)
})

test('consumeSearchRateLimit rejects over the daily ceiling and refunds the burst slot', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-31T04:00:00.000Z'))
	await using harness = await createDb()
	const { sqlite, db } = harness
	const dailyLimit = searchRateLimitByPlan.free.daily.maxRequests
	const dailyKey = searchDailyRateLimitKey('user-search-3')
	const burstKey = searchBurstRateLimitKey('user-search-3')
	const now = Math.floor(Date.now() / 1000)

	await consumeSearchRateLimit({
		db,
		userId: 'user-search-3',
		email: 'user@example.com',
	})
	await pgQuery(sqlite).run(`DELETE FROM _rate_limits WHERE key = ?`, burstKey)
	await pgQuery(sqlite).run(`DELETE FROM _rate_limits WHERE key = ?`, dailyKey)
	await sqlite.query(
		`INSERT INTO _rate_limits (key, ts) SELECT $1, $2 FROM generate_series(1, $3::integer)`,
		[dailyKey, now, dailyLimit],
	)

	const error = await consumeSearchRateLimit({
		db,
		userId: 'user-search-3',
		email: 'user@example.com',
	}).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(isSearchRateLimitError(error)).toBe(true)
	expect(error).toBeInstanceOf(SearchRateLimitError)
	if (!(error instanceof SearchRateLimitError)) {
		throw new Error('expected SearchRateLimitError')
	}
	expect(error.window).toBe('day')
	expect(error.limit).toBe(dailyLimit)
	expect(
		await pgQuery(sqlite).get(
			`SELECT COUNT(*) AS n FROM _rate_limits WHERE key = ?`,
			burstKey,
		),
	).toEqual({ n: 0 })

	vi.useRealTimers()
})
