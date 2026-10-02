import { expect, test, vi } from 'vitest'
import { createPgDatabase, type SqlDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { type FeatureFlagSuccessMetric } from '#universal/feature-flags/registry.ts'
import {
	attachFeatureFlagMetricReadouts,
	loadFeatureFlagSuccessMetricReadout,
	resolveFlagExposuresDataset,
} from './success-metric-readout.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'

const successMetric: FeatureFlagSuccessMetric = {
	eventType: 'execute',
	measure: 'error_rate',
	goal: 'decrease',
	hypothesis: 'Fewer execute errors.',
}

const now = new Date('2026-07-15T12:00:00.000Z')

type ExposureRow = [
	flagKey: string,
	userId: string,
	day: string,
	enabled: 0 | 1,
	source: string,
]
type UsageRow = [
	userId: string,
	metric: string,
	month: string,
	eventCount: number,
	errorCount: number,
	totalDurationMs: number,
]

async function createReadoutTestDb(
	input: { exposures?: Array<ExposureRow>; usage?: Array<UsageRow> } = {},
) {
	const database = await createTestDb()
	for (const [flagKey, userId, day, enabled, source] of input.exposures ?? [])
		await database.pg.query(
			`INSERT INTO feature_flag_exposure_rollups
				(flag_key, user_id, day, enabled, source, exposure_count, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 1, $3 || 'T00:00:00.000Z')`,
			[flagKey, userId, day, enabled, source],
		)
	for (const row of input.usage ?? [])
		await database.pg.query(
			`INSERT INTO usage_rollups
				(user_id, metric, month, event_count, error_count, total_duration_ms)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			row,
		)
	return {
		...database,
		// The admin surface selects this role after its permission check.
		analytics: createPgDatabase({
			connection: database.pg,
			role: 'kody_analytics',
		}),
	}
}

test('relational readout excludes mixed users from on/off and surfaces override usage', async () => {
	const flag = 'metric-test-flag'
	await using database = await createReadoutTestDb({
		exposures: [
			[flag, 'user-on', '2026-07-08', 1, 'rollout'],
			[flag, 'user-on', '2026-07-10', 1, 'rollout'],
			[flag, 'user-on-quiet', '2026-07-10', 1, 'rollout'],
			[flag, 'user-off', '2026-07-10', 0, 'rollout'],
			[flag, 'user-override', '2026-07-12', 1, 'override'],
			[flag, 'user-mixed', '2026-07-05', 0, 'rollout'],
			[flag, 'user-mixed', '2026-07-12', 1, 'rollout'],
			// Outside the month-to-date window or for another flag: each would
			// turn its user into a mixed exposure if the filters leaked.
			[flag, 'user-off', '2026-06-30', 1, 'rollout'],
			[flag, 'user-on', '2026-07-16', 0, 'rollout'],
			['other-flag', 'user-on-quiet', '2026-07-10', 0, 'rollout'],
		],
		usage: [
			['user-on', 'execute', '2026-07', 10, 2, 1000],
			['user-off', 'execute', '2026-07', 8, 4, 400],
			['user-override', 'execute', '2026-07', 100, 0, 0],
			['user-mixed', 'execute', '2026-07', 20, 1, 200],
			['user-unexposed', 'execute', '2026-07', 50, 50, 0],
			['user-on', 'execute', '2026-06', 999, 999, 999],
			['user-on', 'search', '2026-07', 777, 777, 777],
		],
	})

	const readout = await loadFeatureFlagSuccessMetricReadout(
		{ APP_DB: database.analytics },
		{ flagKey: flag, successMetric },
		now,
	)

	expect(readout).toEqual({
		status: 'ok',
		windowStart: '2026-07-01T00:00:00.000Z',
		windowEnd: '2026-07-15T12:00:00.000Z',
		on: {
			users: 2,
			eventCount: 10,
			errorCount: 2,
			errorRate: 0.2,
			avgDurationMs: 100,
		},
		off: {
			users: 1,
			eventCount: 8,
			errorCount: 4,
			errorRate: 0.5,
			avgDurationMs: 50,
		},
		override: {
			users: 1,
			eventCount: 100,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 0,
		},
		overrideUsers: 1,
		mixedUsers: 1,
	})

	// Analytics sees counters only, read-only; ordinary roles see one user.
	await expect(
		database.analytics.prepare('SELECT email FROM users').all(),
	).rejects.toThrow('permission denied')
	await expect(
		database.analytics.prepare('DELETE FROM usage_rollups').run(),
	).rejects.toThrow('read-only transaction')
	expect(
		await loadFeatureFlagSuccessMetricReadout(
			{ APP_DB: database.forUser('user-on').reader },
			{ flagKey: flag, successMetric },
			now,
		),
	).toMatchObject({
		on: { users: 1, eventCount: 10 },
		off: { users: 0 },
		override: { users: 0 },
		mixedUsers: 0,
	})
})

test('Analytics Engine readout joins exposures and usage; mixed stay excluded', async () => {
	const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
		const query = String((init as { body: string }).body)
		if (query.includes('kody_flag_exposures')) {
			return new Response(
				JSON.stringify({
					data: [
						{
							user_id: 'user-on',
							state: 'on',
							source: 'global',
							last_ts: '2026-07-10 00:00:00',
						},
						{
							user_id: 'user-off',
							state: 'off',
							source: 'global',
							last_ts: '2026-07-10 00:00:00',
						},
						{
							user_id: 'user-override',
							state: 'on',
							source: 'override',
							last_ts: '2026-07-12 00:00:00',
						},
						{
							user_id: 'user-switched',
							state: 'off',
							source: 'global',
							last_ts: '2026-07-02 00:00:00',
						},
						{
							user_id: 'user-switched',
							state: 'on',
							source: 'global',
							last_ts: '2026-07-14 00:00:00',
						},
					],
				}),
			)
		}
		return new Response(
			JSON.stringify({
				data: [
					{
						user_id: 'user-on',
						event_count: 4,
						error_count: 1,
						total_duration_ms: 800,
					},
					{
						user_id: 'user-off',
						event_count: 5,
						error_count: 5,
						total_duration_ms: 500,
					},
					{
						user_id: 'user-switched',
						event_count: 6,
						error_count: 0,
						total_duration_ms: 60,
					},
					{
						user_id: 'user-override',
						event_count: 50,
						error_count: 0,
						total_duration_ms: 0,
					},
				],
			}),
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const readout = await loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: {} as SqlDatabase,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
				CLOUDFLARE_ACCOUNT_ID: 'account',
				CLOUDFLARE_API_TOKEN: 'token',
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		)

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const exposuresQuery = fetchMock.mock.calls
			.map(([, init]) => String((init as { body: string }).body))
			.find((query) => query.includes('kody_flag_exposures'))
		// Analytics Engine rejects max() over String columns with HTTP 422.
		expect(exposuresQuery).toContain('max(timestamp) AS last_ts')
		expect(exposuresQuery).not.toMatch(/max\(blob\d+\)/)
		expect(readout).toMatchObject({
			status: 'ok',
			on: { users: 1, eventCount: 4, errorCount: 1 },
			off: { users: 1, eventCount: 5, errorCount: 5, errorRate: 1 },
			override: { users: 1, eventCount: 50, errorCount: 0 },
			overrideUsers: 1,
			mixedUsers: 1,
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('selects the relational store locally, stays unavailable without credentials, and degrades on failure', async () => {
	await using local = await createReadoutTestDb({
		exposures: [['metric-test-flag', 'user-on', '2026-07-10', 1, 'rollout']],
		usage: [['user-on', 'execute', '2026-07', 3, 0, 30]],
	})
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: local.analytics,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
				CLOUDFLARE_ACCOUNT_ID: 'account',
				CLOUDFLARE_API_TOKEN: 'token',
				WRANGLER_IS_LOCAL_DEV: 'true',
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toMatchObject({ status: 'ok', on: { users: 1, eventCount: 3 } })

	silenceExpectedConsoleWarns(['flag-metric-readout-failed'])
	const failingDb = {
		prepare() {
			throw new Error('database down')
		},
	} as unknown as SqlDatabase

	// Falling back to empty relational tables would present confident zero
	// cohorts even though exposures were written to Analytics Engine.
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: failingDb,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('credentials'),
	})
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{ APP_DB: failingDb },
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('failed'),
	})

	const aeError =
		'Input was invalid: cannot use the String type as argument 1 in max("blob5")'
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(aeError, { status: 422 })),
	)
	try {
		await expect(
			loadFeatureFlagSuccessMetricReadout(
				{
					APP_DB: {} as SqlDatabase,
					FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
					CLOUDFLARE_ACCOUNT_ID: 'account',
					CLOUDFLARE_API_TOKEN: 'token',
				},
				{ flagKey: 'metric-test-flag', successMetric },
				now,
			),
		).resolves.toEqual({
			status: 'unavailable',
			reason: expect.stringContaining(`(422): ${aeError}`),
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('resolveFlagExposuresDataset picks preview vs production table names', () => {
	expect(resolveFlagExposuresDataset({})).toBe('kody_flag_exposures')
	expect(resolveFlagExposuresDataset({ SENTRY_ENVIRONMENT: 'preview' })).toBe(
		'kody_flag_exposures_preview',
	)
})

test('attachFeatureFlagMetricReadouts only fills measured non-stale flags', async () => {
	await using database = await createReadoutTestDb()
	const flags: Array<AdminFeatureFlag> = [
		{
			key: 'demo-indicator',
			description: null,
			defaultEnabled: false,
			defaultAudience: 'everyone',
			stale: false,
			successMetric,
			global: null,
			overrides: [],
		},
		{
			key: 'demo-indicator',
			description: null,
			defaultEnabled: false,
			defaultAudience: 'everyone',
			stale: false,
			successMetric: null,
			global: null,
			overrides: [],
		},
		{
			key: 'retired-flag',
			description: null,
			defaultEnabled: null,
			defaultAudience: null,
			stale: true,
			successMetric: null,
			global: null,
			overrides: [],
		},
	]
	await attachFeatureFlagMetricReadouts(
		{ APP_DB: database.analytics },
		flags,
		now,
	)
	expect(flags[0]?.metricReadout).toMatchObject({ status: 'ok' })
	expect(flags[1]?.metricReadout).toBeUndefined()
	expect(flags[2]?.metricReadout).toBeUndefined()
})
