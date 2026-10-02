import { createTestFeatureFlagsDb } from '#worker/test-support/aws/test-feature-flags-db.ts'
import { expect, test } from 'vitest'
import {
	clearFeatureFlagUserOverride,
	computeRolloutBucket,
	deleteStaleFeatureFlag,
	getFeatureFlagEvaluationsForUser,
	getFeatureFlagsForUser,
	isFeatureEnabled,
	isFeatureGloballyEnabled,
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
	setFeatureFlagUserOverride,
} from './service.ts'

test('isFeatureEnabled falls back to registry default when no DB state exists', async () => {
	await using db = await createTestFeatureFlagsDb()
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(
		false,
	)
	await expect(getFeatureFlagsForUser(db, 1)).resolves.toEqual({
		'demo-indicator': false,
		'compact-mcp-server-instructions': false,
		'package-share-grants': false,
		'secret-providers': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
	})
})

test('global on/off and percentage rollout evaluation', async () => {
	await using db = await createTestFeatureFlagsDb()

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 9,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(false)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		note: 'fully on',
		updatedBy: 9,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(true)
	await expect(isFeatureGloballyEnabled(db, 'demo-indicator')).resolves.toBe(
		true,
	)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: 50,
		updatedBy: 9,
	})
	const userIn = 1
	const userOut = 2
	const bucketIn = computeRolloutBucket('demo-indicator', userIn)
	const bucketOut = computeRolloutBucket('demo-indicator', userOut)
	// Pick users whose buckets land on opposite sides of 50 for this key.
	let enabledUser = userIn
	let disabledUser = userOut
	if (bucketIn >= 50 && bucketOut < 50) {
		enabledUser = userOut
		disabledUser = userIn
	} else if (bucketIn >= 50 && bucketOut >= 50) {
		for (let candidate = 3; candidate < 10_000; candidate += 1) {
			if (computeRolloutBucket('demo-indicator', candidate) < 50) {
				enabledUser = candidate
				disabledUser = userIn
				break
			}
		}
	} else if (bucketIn < 50 && bucketOut < 50) {
		for (let candidate = 3; candidate < 10_000; candidate += 1) {
			if (computeRolloutBucket('demo-indicator', candidate) >= 50) {
				disabledUser = candidate
				enabledUser = userIn
				break
			}
		}
	}
	await expect(
		isFeatureEnabled(db, 'demo-indicator', enabledUser),
	).resolves.toBe(true)
	await expect(
		isFeatureEnabled(db, 'demo-indicator', disabledUser),
	).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(
		false,
	)
	await expect(isFeatureGloballyEnabled(db, 'demo-indicator')).resolves.toBe(
		true,
	)

	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 101,
			updatedBy: 9,
		}),
	).rejects.toThrow(/rolloutPercent/)
	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 12.5,
			updatedBy: 9,
		}),
	).rejects.toThrow(/rolloutPercent/)

	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			note: 42,
			updatedBy: 9,
		}),
	).rejects.toThrow(/note must be a string/)
	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			note: 'x'.repeat(501),
			updatedBy: 9,
		}),
	).rejects.toThrow(/note must be at most 500 characters/)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		note: 'keep me',
		updatedBy: 9,
	})
	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 9,
	})
	expect(
		await db
			.prepare("SELECT note FROM feature_flags WHERE key = 'demo-indicator'")
			.first('note'),
	).toBe('keep me')

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		note: '',
		updatedBy: 9,
	})
	expect(
		await db
			.prepare("SELECT note FROM feature_flags WHERE key = 'demo-indicator'")
			.first('note'),
	).toBe('')
})

test('computeRolloutBucket is deterministic and spreads across 0-99', () => {
	expect(computeRolloutBucket('demo-indicator', 42)).toBe(
		computeRolloutBucket('demo-indicator', 42),
	)
	expect(computeRolloutBucket('demo-indicator', 1)).not.toBe(
		computeRolloutBucket('other-flag', 1),
	)

	const buckets = new Set<number>()
	for (let userId = 1; userId <= 2_000; userId += 1) {
		const bucket = computeRolloutBucket('demo-indicator', userId)
		expect(bucket).toBeGreaterThanOrEqual(0)
		expect(bucket).toBeLessThan(100)
		buckets.add(bucket)
	}
	// Sanity: a decent spread across the 0–99 range for 2000 samples.
	expect(buckets.size).toBeGreaterThan(80)
})

test('user override wins over global off and global on; clear restores evaluation', async () => {
	await using db = await createTestFeatureFlagsDb()

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: true,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(false)
	await expect(getFeatureFlagsForUser(db, 7)).resolves.toEqual({
		'demo-indicator': true,
		'compact-mcp-server-instructions': false,
		'package-share-grants': false,
		'secret-providers': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
	})

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: false,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(true)

	await expect(
		clearFeatureFlagUserOverride(db, { key: 'demo-indicator', userId: 7 }),
	).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(true)
	await expect(
		clearFeatureFlagUserOverride(db, { key: 'demo-indicator', userId: 7 }),
	).resolves.toBe(false)
})

test('getFeatureFlagEvaluationsForUser reports assignment sources', async () => {
	await using db = await createTestFeatureFlagsDb()

	await expect(getFeatureFlagEvaluationsForUser(db, 7)).resolves.toEqual({
		'demo-indicator': { enabled: false, source: 'default' },
		'compact-mcp-server-instructions': { enabled: false, source: 'default' },
		'package-share-grants': { enabled: false, source: 'default' },
		'secret-providers': { enabled: false, source: 'default' },
		'jev-search-rerank': { enabled: false, source: 'default' },
		'execute-invoke': { enabled: false, source: 'default' },
	})

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await expect(getFeatureFlagEvaluationsForUser(db, 7)).resolves.toMatchObject({
		'demo-indicator': { enabled: true, source: 'global' },
	})

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: 50,
		updatedBy: 1,
	})
	const evaluations = await getFeatureFlagEvaluationsForUser(db, 7)
	expect(evaluations['demo-indicator'].source).toBe('rollout')
	expect(evaluations['demo-indicator'].enabled).toBe(
		computeRolloutBucket('demo-indicator', 7) < 50,
	)
	// Anonymous users are excluded from percentage rollouts but the
	// assignment is still rollout-sourced.
	await expect(
		getFeatureFlagEvaluationsForUser(db, null),
	).resolves.toMatchObject({
		'demo-indicator': { enabled: false, source: 'rollout' },
	})

	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: false,
		updatedBy: 1,
	})
	await expect(getFeatureFlagEvaluationsForUser(db, 7)).resolves.toMatchObject({
		'demo-indicator': { enabled: false, source: 'override' },
	})
})

test('listFeatureFlagsForAdmin includes registry flags and stale DB-only keys', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [
			{ id: 3, username: 'alice' },
			{ id: 4, username: 'bob' },
		],
		globals: [
			{
				key: 'demo-indicator',
				enabled: 1,
				rollout_percent: 25,
				audience: 'everyone',
				note: 'rolling out',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
			{
				key: 'retired-flag',
				enabled: 0,
				rollout_percent: null,
				audience: 'everyone',
				note: 'leftover',
				updated_by: null,
				updated_at: '2026-06-01T00:00:00.000Z',
			},
		],
		overrides: [
			{
				flag_key: 'demo-indicator',
				user_id: 4,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-02T00:00:00.000Z',
			},
			{
				flag_key: 'orphan-override',
				user_id: 3,
				enabled: 0,
				updated_by: 1,
				updated_at: '2026-07-03T00:00:00.000Z',
			},
		],
	})

	const listed = await listFeatureFlagsForAdmin(db)
	expect(listed).toHaveLength(8)

	const sharing = listed.find((flag) => flag.key === 'package-share-grants')
	expect(sharing).toMatchObject({
		key: 'package-share-grants',
		stale: false,
		defaultEnabled: false,
		successMetric: null,
	})

	const secretProviders = listed.find((flag) => flag.key === 'secret-providers')
	expect(secretProviders).toMatchObject({
		key: 'secret-providers',
		stale: false,
		defaultEnabled: false,
		successMetric: null,
	})

	const jevSearch = listed.find((flag) => flag.key === 'jev-search-rerank')
	expect(jevSearch).toMatchObject({
		key: 'jev-search-rerank',
		stale: false,
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		successMetric: {
			eventType: 'execute',
			measure: 'event_count',
			goal: 'increase',
		},
	})

	expect(
		listed.find((flag) => flag.key === 'execute-invoke')?.defaultAudience,
	).toBe('experiments_opt_in')

	const compact = listed.find(
		(flag) => flag.key === 'compact-mcp-server-instructions',
	)
	expect(compact).toMatchObject({
		key: 'compact-mcp-server-instructions',
		stale: false,
		defaultEnabled: false,
		successMetric: {
			eventType: 'execute',
			measure: 'event_count',
			goal: 'increase',
		},
	})
	const demo = listed.find((flag) => flag.key === 'demo-indicator')
	expect(demo).toMatchObject({
		key: 'demo-indicator',
		stale: false,
		defaultEnabled: false,
		successMetric: null,
		global: {
			enabled: true,
			rolloutPercent: 25,
			audience: 'everyone',
			note: 'rolling out',
			updatedByStableUserId: 'stable-1',
		},
		overrides: [
			{
				stableUserId: 'stable-4',
				username: 'bob',
				enabled: true,
			},
		],
	})
	const retired = listed.find((flag) => flag.key === 'retired-flag')
	expect(retired).toEqual({
		key: 'retired-flag',
		description: null,
		defaultEnabled: null,
		defaultAudience: null,
		stale: true,
		successMetric: null,
		global: {
			enabled: false,
			rolloutPercent: null,
			audience: 'everyone',
			note: 'leftover',
			updatedByStableUserId: null,
			updatedAt: '2026-06-01T00:00:00.000Z',
		},
		overrides: [],
	})

	const orphan = listed.find((flag) => flag.key === 'orphan-override')
	expect(orphan).toEqual({
		key: 'orphan-override',
		description: null,
		defaultEnabled: null,
		defaultAudience: null,
		stale: true,
		successMetric: null,
		global: null,
		overrides: [
			{
				stableUserId: 'stable-3',
				username: 'alice',
				enabled: false,
				updatedAt: '2026-07-03T00:00:00.000Z',
			},
		],
	})
})

test('deleteStaleFeatureFlag refuses registry keys and removes stale rows', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [{ id: 3, username: 'alice' }],
		globals: [
			{
				key: 'demo-indicator',
				enabled: 1,
				rollout_percent: null,
				audience: 'everyone',
				note: '',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
			{
				key: 'retired-flag',
				enabled: 1,
				rollout_percent: null,
				audience: 'everyone',
				note: '',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
		overrides: [
			{
				flag_key: 'retired-flag',
				user_id: 3,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	await expect(deleteStaleFeatureFlag(db, 'demo-indicator')).rejects.toThrow(
		/Cannot delete registry feature flag/,
	)
	expect(
		Boolean(
			await db
				.prepare("SELECT key FROM feature_flags WHERE key = 'demo-indicator'")
				.first(),
		),
	).toBe(true)

	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(true)
	expect(
		Boolean(
			await db
				.prepare("SELECT key FROM feature_flags WHERE key = 'retired-flag'")
				.first(),
		),
	).toBe(false)
	expect(
		(
			await db
				.prepare('SELECT COUNT(*) AS total FROM feature_flag_user_overrides')
				.first<{ total: number }>()
		)?.total,
	).toBe(0)
	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(false)
})

test('experiments_opt_in audience requires users.experiments_opt_in; overrides still win', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [
			{ id: 7, username: 'opted', experiments_opt_in: 1 },
			{ id: 8, username: 'plain', experiments_opt_in: 0 },
			{ id: 9, username: 'plain-two', experiments_opt_in: 0 },
		],
	})

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		audience: 'experiments_opt_in',
		updatedBy: 1,
	})

	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', 9)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(
		false,
	)

	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 8,
		enabled: true,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(true)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 9)).resolves.toBe(false)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		audience: 'everyone',
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 9)).resolves.toBe(true)

	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			audience: 'not-a-real-audience',
			updatedBy: 1,
		}),
	).rejects.toThrow(/audience must be one of/)
})

test('execute-invoke first insert without audience uses registry defaultAudience', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [
			{ id: 7, username: 'opted', experiments_opt_in: 1 },
			{ id: 8, username: 'plain', experiments_opt_in: 0 },
		],
	})

	await setFeatureFlagGlobalState(db, {
		key: 'execute-invoke',
		enabled: true,
		rolloutPercent: null,
		updatedBy: 1,
	})
	expect(
		await db
			.prepare(
				"SELECT audience FROM feature_flags WHERE key = 'execute-invoke'",
			)
			.first('audience'),
	).toBe('experiments_opt_in')
	await expect(isFeatureEnabled(db, 'execute-invoke', 7)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'execute-invoke', 8)).resolves.toBe(false)
})

test('Postgres flag overrides stay scoped to the evaluated user and reader refuses changes', async () => {
	await using db = await createTestFeatureFlagsDb()
	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: true,
		updatedBy: 1,
	})
	const alice = db.forUser('stable-7')
	const bob = db.forUser('stable-8')
	expect(await isFeatureEnabled(alice.reader, 'demo-indicator', 7)).toBe(true)
	expect(await isFeatureEnabled(bob.reader, 'demo-indicator', 8)).toBe(false)
	expect(
		await bob.reader.prepare('SELECT * FROM feature_flag_user_overrides').all(),
	).toMatchObject({ results: [] })
	await expect(
		setFeatureFlagUserOverride(bob.db, {
			key: 'demo-indicator',
			userId: 7,
			enabled: false,
			updatedBy: 8,
		}),
	).rejects.toThrow('row-level security')
	await expect(
		setFeatureFlagGlobalState(bob.db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			updatedBy: 8,
		}),
	).rejects.toThrow('permission denied')
	await expect(
		clearFeatureFlagUserOverride(alice.reader, {
			key: 'demo-indicator',
			userId: 7,
		}),
	).rejects.toThrow('read-only transaction')
})
