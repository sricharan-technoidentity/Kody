import { expect, test, vi } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	authRateLimitConfig,
	checkAuthRateLimit,
	checkRateLimit,
	releaseRateLimit,
} from './rate-limit.ts'

test('database rate limiting caps one key, prunes only that key and refunds a slot', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-31T04:00:00.000Z'))
	await using store = await createTestDb({ userId: 'limited-user' })
	const config = { maxRequests: 2, windowSeconds: 60 }
	const rows = async () =>
		(
			await store.pg.query<{ key: string; ts: number }>(
				`SELECT key, ts::int AS ts FROM _rate_limits ORDER BY id`,
			)
		).rows

	await checkRateLimit(store.db, 'auth:ip:current', config)
	await store.pg.query(
		`INSERT INTO _rate_limits (key, ts) VALUES ('webhook:user:other', 1), ('auth:ip:current', 1)`,
	)
	await expect(
		checkRateLimit(store.db, 'auth:ip:current', config),
	).resolves.toEqual({ allowed: true, retryAfterSeconds: null })
	expect((await rows()).filter((row) => row.ts === 1)).toEqual([
		{ key: 'webhook:user:other', ts: 1 },
	])

	await expect(
		checkRateLimit(store.db, 'auth:ip:current', config),
	).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 })
	await releaseRateLimit(store.db, 'auth:ip:current')
	await expect(
		checkRateLimit(store.db, 'auth:ip:current', config),
	).resolves.toEqual({ allowed: true, retryAfterSeconds: null })
	expect(
		(await rows()).filter((row) => row.key === 'auth:ip:current'),
	).toHaveLength(2)

	// Keys carry user ids and IPs, so runtime roles reach rows only through the definers.
	await expect(
		store.db.prepare(`SELECT key FROM _rate_limits`).all(),
	).rejects.toThrow(/permission denied/)
	await expect(
		store.db
			.prepare(`DELETE FROM _rate_limits WHERE key = ?`)
			.bind('webhook:user:other')
			.run(),
	).rejects.toThrow(/permission denied/)
	await expect(
		checkRateLimit(store.reader, 'auth:ip:current', config),
	).rejects.toThrow(/permission denied/)

	vi.useRealTimers()
})

test('auth binding preserves the ten requests per sixty seconds contract', async () => {
	let requests = 0
	const limit = vi.fn(async ({ key }: RateLimitOptions) => {
		expect(key).toBe('auth:ip:198.51.100.42')
		requests++
		return { success: requests <= authRateLimitConfig.maxRequests }
	})
	const env = {
		AUTH_RATE_LIMITER: { limit },
		APP_DB: null as unknown as D1Database,
	}

	for (let index = 0; index < authRateLimitConfig.maxRequests; index++) {
		await expect(
			checkAuthRateLimit(env, 'auth:ip:198.51.100.42'),
		).resolves.toEqual({ allowed: true, retryAfterSeconds: null })
	}
	await expect(
		checkAuthRateLimit(env, 'auth:ip:198.51.100.42'),
	).resolves.toEqual({
		allowed: false,
		retryAfterSeconds: authRateLimitConfig.windowSeconds,
	})
	expect(limit).toHaveBeenCalledTimes(11)
})
