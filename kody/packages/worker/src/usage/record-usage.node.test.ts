import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const spanCalls = vi.hoisted(() => ({
	spans: [] as Array<{
		name: string
		attributes: Record<string, boolean | number | string | undefined>
	}>,
}))

vi.mock('cloudflare:workers', () => ({
	tracing: {
		enterSpan(
			name: string,
			callback: (span: {
				isTraced: boolean
				setAttribute(key: string, value?: boolean | number | string): void
				end(): void
			}) => unknown,
		) {
			const attributes: Record<string, boolean | number | string | undefined> =
				{}
			spanCalls.spans.push({ name, attributes })
			return callback({
				isTraced: true,
				setAttribute(key, value) {
					attributes[key] = value
				},
				end() {},
			})
		},
	},
}))

const { recordUsage, usageEventBlobIndexes, usageEventDoubleIndexes } =
	await import('./record-usage.ts')
const { createTestDb } = await import('#worker/test-support/aws/test-db.ts')

/** Rollups land on each user's own RLS writer; assertions read as superuser. */
const usageDb = await createTestDb()
const writerFor = (userId: string) =>
	usageDb.forUser(userId).db as unknown as D1Database
async function listRollups(userId: string) {
	const { rows } = await usageDb.pg.query(
		`SELECT user_id, metric, month, event_count::int, error_count::int,
			total_duration_ms::int, total_cpu_ms::int, total_bytes::int
		FROM usage_rollups WHERE user_id = $1
		ORDER BY metric, month`,
		[userId],
	)
	return rows
}

test('recordUsage emits kody.usage spans with attributes and skips empty userId', async () => {
	spanCalls.spans.length = 0

	await recordUsage(
		{},
		{
			userId: 'user-1',
			eventType: 'execute',
			entityId: 'pkg-1',
			durationMs: 120,
			bytes: 512,
			outcome: 'error',
		},
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.execute',
			attributes: {
				'kody.user_id': 'user-1',
				'kody.event_type': 'execute',
				'kody.outcome': 'error',
				'kody.entity_id': 'pkg-1',
				'kody.duration_ms': 120,
				'kody.bytes': 512,
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: 'user-2', eventType: 'job_run', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.job_run',
			attributes: {
				'kody.user_id': 'user-2',
				'kody.event_type': 'job_run',
				'kody.outcome': 'success',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: '', eventType: 'execute', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([])
})

test('recordUsage writes only Analytics Engine data points when USAGE_EVENTS is bound', async () => {
	const userA = `usage-user-a-${crypto.randomUUID()}`
	const userB = `usage-user-b-${crypto.randomUUID()}`
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const usageEnv = {
		APP_DB: writerFor(userA),
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}
	const usageEnvB = usageEnv

	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		durationMs: 120,
		outcome: 'success',
		timestamp: '2026-07-05T10:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		entityId: 'pkg-1',
		durationMs: 80,
		bytes: 512,
		outcome: 'error',
		timestamp: '2026-07-05T11:00:00.000Z',
	})
	await recordUsage(usageEnvB, {
		userId: userB,
		eventType: 'execute',
		durationMs: 40,
		outcome: 'success',
		timestamp: '2026-07-05T12:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'durable_object_gb_seconds',
		entityId: 'StorageRunner',
		durationMs: 10_000,
		eventCount: 8,
		outcome: 'success',
		timestamp: '2026-07-05T12:30:00.000Z',
	})

	expect(dataPoints).toHaveLength(4)
	expect(dataPoints[0]).toEqual({
		indexes: [userA],
		blobs: [
			userA,
			'execute',
			'',
			'success',
			'2026-07-05T10:00:00.000Z',
			'',
			'',
			'',
		],
		doubles: [120, 0, 0, 0, 0],
	})
	expect(dataPoints[1]).toEqual({
		indexes: [userA],
		blobs: [
			userA,
			'execute',
			'pkg-1',
			'error',
			'2026-07-05T11:00:00.000Z',
			'',
			'',
			'',
		],
		doubles: [80, 0, 512, 0, 0],
	})
	expect(dataPoints[2]?.indexes).toEqual([userB])
	expect(dataPoints[3]).toEqual({
		indexes: [userA],
		blobs: [
			userA,
			'durable_object_gb_seconds',
			'StorageRunner',
			'success',
			'2026-07-05T12:30:00.000Z',
			'',
			'',
			'',
		],
		doubles: [10_000, 0, 8, 0, 0],
	})

	// Production path: usage_rollups is a derived aggregate recomputed by the
	// hourly aggregation cron, never written per event.
	expect(await listRollups(userA)).toEqual([])
	expect(await listRollups(userB)).toEqual([])
})

test('recordUsage accumulates per-user monthly rollups without USAGE_EVENTS (local dev)', async () => {
	const userA = `usage-user-a-${crypto.randomUUID()}`
	const userB = `usage-user-b-${crypto.randomUUID()}`
	const usageEnv = { APP_DB: writerFor(userA) }
	const usageEnvB = { APP_DB: writerFor(userB) }

	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		durationMs: 120,
		outcome: 'success',
		timestamp: '2026-07-05T10:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		entityId: 'pkg-1',
		durationMs: 80,
		bytes: 512,
		outcome: 'error',
		timestamp: '2026-07-05T11:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'email_send',
		entityId: 'message-1',
		bytes: 2048,
		outcome: 'success',
		timestamp: '2026-08-01T00:00:00.000Z',
	})
	await recordUsage(usageEnvB, {
		userId: userB,
		eventType: 'execute',
		durationMs: 40,
		outcome: 'success',
		timestamp: '2026-07-05T12:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'durable_object_gb_seconds',
		entityId: 'StorageRunner',
		durationMs: 10_000,
		eventCount: 8,
		outcome: 'success',
		timestamp: '2026-07-05T10:30:00.000Z',
	})

	expect(await listRollups(userA)).toEqual([
		{
			user_id: userA,
			metric: 'durable_object_gb_seconds',
			month: '2026-07',
			event_count: 8,
			error_count: 0,
			total_duration_ms: 10_000,
			total_cpu_ms: 0,
			total_bytes: 0,
		},
		{
			user_id: userA,
			metric: 'email_send',
			month: '2026-08',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 0,
			total_cpu_ms: 0,
			total_bytes: 2048,
		},
		{
			user_id: userA,
			metric: 'execute',
			month: '2026-07',
			event_count: 2,
			error_count: 1,
			total_duration_ms: 200,
			total_cpu_ms: 0,
			total_bytes: 512,
		},
	])
	// Cross-user isolation: user B only ever sees their own single event.
	expect(await listRollups(userB)).toEqual([
		{
			user_id: userB,
			metric: 'execute',
			month: '2026-07',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 40,
			total_cpu_ms: 0,
			total_bytes: 0,
		},
	])
})

test('recordUsage never throws when bindings are missing, sinks fail, or userId is empty', async () => {
	consoleWarn.mockImplementation(() => {})
	const userId = `usage-degrade-user-${crypto.randomUUID()}`
	await using degradeDb = await createTestDb({ userId })
	const appDb = degradeDb.db as unknown as D1Database

	// No bindings at all (local dev / test without Analytics Engine).
	await expect(
		recordUsage({}, { userId, eventType: 'execute', outcome: 'success' }),
	).resolves.toBeUndefined()

	// Analytics Engine sink throws: degrade, don't throw, and never fall back
	// to the per-event D1 upsert (production must not write rollups inline).
	await expect(
		recordUsage(
			{
				APP_DB: appDb,
				USAGE_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics engine unavailable')
					},
				},
			},
			{
				userId,
				eventType: 'job_run',
				entityId: 'job-1',
				durationMs: 10,
				outcome: 'success',
				timestamp: '2026-07-05T10:00:00.000Z',
			},
		),
	).resolves.toBeUndefined()
	expect(await listRollups(userId)).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-event-analytics-failed',
		expect.any(Error),
	)

	// Missing userId: skipped entirely, no row written.
	await expect(
		recordUsage(
			{ APP_DB: appDb },
			{ userId: '', eventType: 'execute', outcome: 'success' },
		),
	).resolves.toBeUndefined()
	expect(await listRollups('')).toEqual([])

	// Rollup table missing: degrade, don't throw.
	await degradeDb.pg.query('DROP TABLE usage_rollups CASCADE')
	await expect(
		recordUsage(
			{ APP_DB: appDb },
			{ userId, eventType: 'execute', outcome: 'success' },
		),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-rollup-failed',
		expect.any(Error),
	)
})

test('recordUsage writes surface and executeShape as trailing Analytics Engine blobs', async () => {
	const userId = `usage-surface-${crypto.randomUUID()}`
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const usageEnv = {
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}

	await recordUsage(usageEnv, {
		userId,
		eventType: 'dynamic_worker_day',
		entityId: 'kody-worker-a',
		outcome: 'success',
		timestamp: '2026-09-01T12:00:00.000Z',
		surface: 'job',
	})
	await recordUsage(usageEnv, {
		userId,
		eventType: 'execute',
		outcome: 'success',
		timestamp: '2026-09-01T12:01:00.000Z',
		surface: 'execute',
		executeShape: 'thin_single_export',
	})

	expect(dataPoints[0]?.blobs).toEqual([
		userId,
		'dynamic_worker_day',
		'kody-worker-a',
		'success',
		'2026-09-01T12:00:00.000Z',
		'job',
		'',
		'',
	])
	expect(dataPoints[1]?.blobs).toEqual([
		userId,
		'execute',
		'',
		'success',
		'2026-09-01T12:01:00.000Z',
		'execute',
		'thin_single_export',
		'',
	])
})

test('recordUsage writes cacheReuse, codeChars, and paramsChars on invoke events', async () => {
	const userId = `usage-invoke-${crypto.randomUUID()}`
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const usageEnv = {
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}

	await recordUsage(usageEnv, {
		userId,
		eventType: 'dynamic_worker_invoke',
		durationMs: 42,
		outcome: 'success',
		timestamp: '2026-09-12T12:00:00.000Z',
		surface: 'execute',
		executeShape: 'glue',
		cacheReuse: 'hit',
		codeChars: 1280,
		paramsChars: 17,
	})

	expect(dataPoints[0]).toEqual({
		indexes: [userId],
		blobs: [
			userId,
			'dynamic_worker_invoke',
			'',
			'success',
			'2026-09-12T12:00:00.000Z',
			'execute',
			'glue',
			'hit',
		],
		doubles: [42, 0, 0, 1280, 17],
	})
	expect(dataPoints[0]?.blobs?.[usageEventBlobIndexes.cacheReuse]).toBe('hit')
	expect(dataPoints[0]?.doubles?.[usageEventDoubleIndexes.codeChars]).toBe(1280)
	expect(dataPoints[0]?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBe(17)
})
