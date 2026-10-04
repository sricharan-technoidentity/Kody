import { expect, test, vi } from 'vitest'
import {
	isRetryableSqlError,
	runSqlWithRetry,
	sqlRetryBaseDelayMs,
} from './sql-retry.ts'

test('PostgreSQL retries use SQLSTATE and traverse causes without looping', () => {
	expect(isRetryableSqlError({ code: '40001' })).toBe(true)
	expect(isRetryableSqlError({ code: '40P01' })).toBe(true)
	expect(
		isRetryableSqlError(new Error('outer', { cause: { code: '08006' } })),
	).toBe(true)
	expect(
		isRetryableSqlError({ code: '23505', message: 'deadlock detected' }),
	).toBe(false)
	expect(isRetryableSqlError(new Error('application fault'))).toBe(false)
	const cycle: { cause?: unknown } = {}
	cycle.cause = cycle
	expect(isRetryableSqlError(cycle)).toBe(false)
})
test('SQL retries back off after serialization failures and immediately rethrow constraints', async () => {
	vi.useFakeTimers()
	try {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error('serialization failure'), { code: '40001' }),
			)
			.mockResolvedValue('ok')
		const pending = runSqlWithRetry(operation)
		await vi.advanceTimersByTimeAsync(sqlRetryBaseDelayMs)
		expect(await pending).toBe('ok')
		expect(operation).toHaveBeenCalledTimes(2)
		const unique = Object.assign(new Error('duplicate'), { code: '23505' })
		const rejected = vi.fn().mockRejectedValue(unique)
		await expect(runSqlWithRetry(rejected)).rejects.toBe(unique)
		expect(rejected).toHaveBeenCalledTimes(1)
	} finally {
		vi.useRealTimers()
	}
})
test('bounded read probes retry hung attempts and exhaust their attempt limit', async () => {
	let attempts = 0
	const operation = vi.fn(async () => {
		if (++attempts === 1) await new Promise(() => {})
		return 'ok'
	})
	await expect(
		runSqlWithRetry(operation, { attemptTimeoutMs: 20, baseDelayMs: 1 }),
	).resolves.toBe('ok')
	expect(operation).toHaveBeenCalledTimes(2)
	const alwaysHung = vi.fn(async () => {
		await new Promise(() => {})
		return 'unused'
	})
	await expect(
		runSqlWithRetry(alwaysHung, {
			maxAttempts: 2,
			attemptTimeoutMs: 15,
			baseDelayMs: 1,
		}),
	).rejects.toThrow('SQL attempt timed out after 15ms')
	expect(alwaysHung).toHaveBeenCalledTimes(2)
})
