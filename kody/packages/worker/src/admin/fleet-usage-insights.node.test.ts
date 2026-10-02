import { expect, test, vi } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const entitlementMocks = vi.hoisted(() => ({
	readAdminEntitlementConsumption: vi.fn(),
}))

vi.mock('#worker/admin/entitlement-consumption.ts', () => ({
	readAdminEntitlementConsumption:
		entitlementMocks.readAdminEntitlementConsumption,
	entitlementWarningThreshold: 0.8,
}))

const {
	detectFleetUsagePressure,
	fleetRuntimeDurationAlertThresholdMs,
	loadFleetEntitlementCrossingSnapshots,
	loadFleetUsageInsights,
} = await import('#worker/admin/fleet-usage-insights.ts')

type FleetUser = {
	stableUserId: string
	username: string
	plan?: string
	stripePlan?: string | null
	ladder?: string
	deletingAt?: string | null
	admin?: boolean
}
type Rollup = [
	userId: string,
	metric: string,
	month: string,
	eventCount: number,
	totalDurationMs: number,
]

async function createFleetDb(input: {
	users: Array<FleetUser>
	rollups: Array<Rollup>
}) {
	const database = await createTestDb()
	for (const [index, user] of input.users.entries()) {
		await database.pg.query(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, plan, stripe_plan, entitlement_ladder, deleting_at)
			 VALUES ($1, $2, $3, 'x', $4, $5, $6, $7, $8)`,
			[
				index + 1,
				user.username,
				`${user.username}@example.test`,
				user.stableUserId,
				user.plan ?? 'free',
				user.stripePlan ?? null,
				user.ladder ?? 'public',
				user.deletingAt ?? null,
			],
		)
		if (user.admin)
			await database.pg.query(
				`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'admin'`,
				[index + 1],
			)
	}
	for (const row of input.rollups)
		await database.pg.query(
			`INSERT INTO usage_rollups (user_id, metric, month, event_count, total_duration_ms)
			 VALUES ($1, $2, $3, $4, $5)`,
			row,
		)
	// Admin insights select this read-only fleet role after the permission check.
	const db = createPgDatabase({
		connection: database.pg,
		role: 'kody_analytics',
	})
	return { ...database, db, env: { APP_DB: db } as unknown as Env }
}

test('loadFleetUsageInsights returns bounded consumer rankings and pressure panel', async () => {
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) =>
			input.usageUserId === 'user-a'
				? [
						{
							resource: 'saved_packages',
							label: 'saved packages',
							current: 9,
							limit: 10,
							percentOfLimit: 0.9,
							overEightyPercent: true,
						},
					]
				: [],
	)
	await using fleet = await createFleetDb({
		users: [
			{ stableUserId: 'user-a', username: 'alice' },
			{ stableUserId: 'user-b', username: 'bob' },
			{ stableUserId: 'user-c', username: 'cara' },
			{
				stableUserId: 'user-gone',
				username: 'gone',
				deletingAt: '2026-07-01T00:00:00.000Z',
			},
		],
		rollups: [
			['user-a', 'execute', '2026-07', 5, 1_000],
			['user-a', 'job_run', '2026-07', 3, 3_599_000],
			['user-a', 'dynamic_worker_day', '2026-07', 60, 0],
			['user-b', 'outbound_fetch', '2026-07', 42, 0],
			// Observe-only metrics never rank event-count consumers.
			['user-b', 'dynamic_worker_invoke', '2026-07', 1_000, 0],
			['user-c', 'dynamic_worker_day', '2026-07', 90, 0],
			// Deleting accounts and other months stay out of every ranking.
			['user-gone', 'execute', '2026-07', 999, 99_999_999],
			['user-a', 'execute', '2026-06', 500, 50_000_000],
		],
	})
	const data = await loadFleetUsageInsights({
		db: fleet.db,
		env: fleet.env,
		now: new Date('2026-07-08T12:00:00.000Z'),
	})
	expect(data.topRuntimeDurationConsumers).toEqual([
		{
			stableUserId: 'user-a',
			username: 'alice',
			totalDurationMs: 3_600_000,
		},
	])
	expect(data.topEventCountConsumers).toEqual([
		{ stableUserId: 'user-c', username: 'cara', eventCount: 90 },
		{ stableUserId: 'user-a', username: 'alice', eventCount: 68 },
		{ stableUserId: 'user-b', username: 'bob', eventCount: 42 },
	])
	expect(data.topDurationConsumersByMetric).toEqual([
		{
			metric: 'execute',
			consumers: [
				{ stableUserId: 'user-a', username: 'alice', totalDurationMs: 1_000 },
			],
		},
		{
			metric: 'job_run',
			consumers: [
				{
					stableUserId: 'user-a',
					username: 'alice',
					totalDurationMs: 3_599_000,
				},
			],
		},
		{ metric: 'workflow_run', consumers: [] },
	])
	expect(data.entitlementPressure).toEqual([
		{
			stableUserId: 'user-a',
			username: 'alice',
			plan: 'free',
			pressuredResources: [
				{
					resource: 'saved_packages',
					label: 'saved packages',
					current: 9,
					limit: 10,
					percentOfLimit: 0.9,
				},
			],
		},
	])
	expect(data.dynamicWorkerCost).toEqual({
		uniqueWorkerDays: 150,
		estimatedGrossUsd: 0.3,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 1000,
		topConsumers: [
			{
				stableUserId: 'user-c',
				username: 'cara',
				uniqueWorkerDays: 90,
				estimatedGrossUsd: 0.18,
				estimatedPaidUsdCents: 0,
				estimatedMarginUsd: -0.18,
				underwater: false,
				paidSource: 'none',
				risk: 'none',
			},
			expect.objectContaining({
				stableUserId: 'user-a',
				uniqueWorkerDays: 60,
				estimatedGrossUsd: 0.12,
			}),
		],
		riskConsumers: [],
	})

	// The fleet role sees counters and account labels, never contact details.
	await expect(
		fleet.db.prepare('SELECT email FROM users').all(),
	).rejects.toThrow('permission denied')
})

test('detectFleetUsagePressure flags entitlement, runtime, and unique-worker cost', async () => {
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => {
			if (input.usageUserId === 'user-a') {
				return [
					{
						resource: 'secrets',
						label: 'secrets',
						current: 9,
						limit: 10,
						percentOfLimit: 0.9,
						overEightyPercent: true,
					},
				]
			}
			if (input.usageUserId === 'user-admin') {
				return [
					{
						resource: 'saved_packages',
						label: 'saved packages',
						current: 9_001,
						limit: 10_000,
						percentOfLimit: 0.9001,
						overEightyPercent: true,
					},
				]
			}
			return []
		},
	)
	await using fleet = await createFleetDb({
		users: [
			{ stableUserId: 'user-a', username: 'alice' },
			{ stableUserId: 'user-b', username: 'bob', plan: 'pro' },
			{
				stableUserId: 'user-admin',
				username: 'kentcdodds',
				plan: 'max',
				admin: true,
			},
		],
		rollups: [
			['user-a', 'execute', '2026-07', 50, 0],
			['user-a', 'dynamic_worker_day', '2026-07', 1_000, 0],
			// Duration outside the runtime metrics never pages.
			['user-a', 'outbound_fetch', '2026-07', 1, 999_999_999],
			[
				'user-b',
				'job_run',
				'2026-07',
				40,
				fleetRuntimeDurationAlertThresholdMs + 1,
			],
			[
				'user-admin',
				'execute',
				'2026-07',
				90,
				fleetRuntimeDurationAlertThresholdMs * 2,
			],
			['user-admin', 'dynamic_worker_day', '2026-07', 50_000, 0],
		],
	})
	const issues = await detectFleetUsagePressure({
		db: fleet.db,
		env: fleet.env,
		now: new Date('2026-07-08T12:00:00.000Z'),
	})
	expect(issues).toEqual([
		{
			kind: 'entitlement',
			stableUserId: 'user-a',
			username: 'alice',
			resource: 'secrets',
			label: 'secrets',
			current: 9,
			limit: 10,
			percentOfLimit: 0.9,
		},
		{
			kind: 'dynamic_worker_cost',
			stableUserId: 'user-a',
			username: 'alice',
			uniqueWorkerDays: 1000,
			estimatedGrossUsd: 2,
			thresholdUsd: 2,
		},
		{
			kind: 'entitlement',
			stableUserId: 'user-admin',
			username: 'kentcdodds',
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9_001,
			limit: 10_000,
			percentOfLimit: 0.9001,
		},
		{
			kind: 'runtime_duration',
			stableUserId: 'user-b',
			username: 'bob',
			totalDurationMs: fleetRuntimeDurationAlertThresholdMs + 1,
		},
	])
	expect(
		entitlementMocks.readAdminEntitlementConsumption.mock.calls.map(
			([input]) => ({
				usageUserId: input.usageUserId,
				plan: input.plan,
				ladder: input.ladder,
			}),
		),
	).toEqual(
		expect.arrayContaining([
			{ usageUserId: 'user-a', plan: 'free', ladder: 'public' },
			{ usageUserId: 'user-b', plan: 'pro', ladder: 'public' },
			{ usageUserId: 'user-admin', plan: 'max', ladder: 'public' },
		]),
	)
})

test('fleet entitlement pressure scores legacy Standard against the legacy outbound ceiling', async () => {
	const outboundCurrent = 15_016
	const publicStandardOutboundLimit = 5_000
	const legacyStandardOutboundLimit = 20_000
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => {
			const limit =
				input.ladder === 'legacy'
					? legacyStandardOutboundLimit
					: publicStandardOutboundLimit
			const percentOfLimit = outboundCurrent / limit
			return [
				{
					resource: 'outbound_fetches_per_day',
					label: 'outbound fetches / day',
					current: outboundCurrent,
					limit,
					percentOfLimit,
					overEightyPercent: percentOfLimit > 0.8,
				},
			]
		},
	)
	await using fleet = await createFleetDb({
		users: [
			{
				stableUserId: 'grant',
				username: 'grant',
				plan: 'standard',
				stripePlan: 'standard',
				ladder: 'legacy',
			},
			{
				stableUserId: 'pat',
				username: 'pat',
				plan: 'standard',
				stripePlan: 'standard',
			},
		],
		rollups: [
			['grant', 'execute', '2026-07', 80, 0],
			['pat', 'execute', '2026-07', 70, 0],
		],
	})
	const now = new Date('2026-07-08T12:00:00.000Z')
	const { db, env } = fleet
	const [snapshots, issues, insights] = await Promise.all([
		loadFleetEntitlementCrossingSnapshots({ db, env, now }),
		detectFleetUsagePressure({ db, env, now }),
		loadFleetUsageInsights({ db, env, now }),
	])
	expect(
		entitlementMocks.readAdminEntitlementConsumption.mock.calls.map(
			([input]) => ({
				usageUserId: input.usageUserId,
				plan: input.plan,
				ladder: input.ladder,
			}),
		),
	).toEqual(
		expect.arrayContaining([
			{ usageUserId: 'grant', plan: 'standard', ladder: 'legacy' },
			{ usageUserId: 'pat', plan: 'standard', ladder: 'public' },
		]),
	)
	expect(snapshots).toEqual([
		expect.objectContaining({
			stableUserId: 'grant',
			plan: 'standard',
			ladder: 'legacy',
			entitlements: [
				expect.objectContaining({
					resource: 'outbound_fetches_per_day',
					current: outboundCurrent,
					limit: legacyStandardOutboundLimit,
					overEightyPercent: false,
				}),
			],
		}),
		expect.objectContaining({
			stableUserId: 'pat',
			plan: 'standard',
			ladder: 'public',
			entitlements: [
				expect.objectContaining({
					resource: 'outbound_fetches_per_day',
					current: outboundCurrent,
					limit: publicStandardOutboundLimit,
					overEightyPercent: true,
				}),
			],
		}),
	])
	expect(issues).toEqual([
		{
			kind: 'entitlement',
			stableUserId: 'pat',
			username: 'pat',
			resource: 'outbound_fetches_per_day',
			label: 'outbound fetches / day',
			current: outboundCurrent,
			limit: publicStandardOutboundLimit,
			percentOfLimit: outboundCurrent / publicStandardOutboundLimit,
		},
	])
	expect(insights.entitlementPressure).toEqual([
		{
			stableUserId: 'pat',
			username: 'pat',
			plan: 'standard',
			pressuredResources: [
				{
					resource: 'outbound_fetches_per_day',
					label: 'outbound fetches / day',
					current: outboundCurrent,
					limit: publicStandardOutboundLimit,
					percentOfLimit: outboundCurrent / publicStandardOutboundLimit,
				},
			],
		},
	])
})
