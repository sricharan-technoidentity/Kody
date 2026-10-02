import { createTestFeatureFlagsDb } from '#worker/test-support/aws/test-feature-flags-db.ts'
import { createTestAuditDb } from '#worker/test-support/aws/test-audit-db.ts'
import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

vi.unmock('#worker/audit-log.ts')
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function createAdminCapabilityContext(
	db: SqlDatabase,
	auditDb: Pick<SqlDatabase, 'prepare'>,
) {
	return {
		env: {
			APP_DB: db,
			AUDIT_DB: auditDb,
			FLAG_EXPOSURES: {},
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
}

test('admin feature flag MCP capabilities: list, set, override, and audit wiring', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [
			{
				id: 1,
				username: 'admin',
				stable_user_id: testStableUserIdFromEmail('admin@example.com'),
			},
			{
				id: 2,
				username: 'jane',
				stable_user_id: testStableUserIdFromEmail('jane@example.com'),
			},
		],
	})
	await using audit = await createTestAuditDb()
	const ctx = createAdminCapabilityContext(db, audit.db)

	const listResult = await adminFeatureFlagListCapability.handler({}, ctx)
	expect(listResult.flags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				description: expect.any(String),
				defaultEnabled: false,
				stale: false,
				global: null,
				overrides: [],
				successMetric: null,
			}),
		]),
	)
	const demoFlag = listResult.flags.find(
		(flag) => flag.key === 'demo-indicator',
	)
	expect(demoFlag?.description).not.toHaveLength(0)

	const setResult = await adminFeatureFlagSetCapability.handler(
		{
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 25,
			note: 'gradual rollout',
		},
		ctx,
	)
	expect(setResult.flag).toMatchObject({
		key: 'demo-indicator',
		global: {
			enabled: true,
			rolloutPercent: 25,
			audience: 'everyone',
			note: 'gradual rollout',
			updatedByStableUserId: testStableUserIdFromEmail('admin@example.com'),
		},
	})
	expect(
		await db
			.prepare(
				"SELECT enabled, rollout_percent, audience, updated_by FROM feature_flags WHERE key = 'demo-indicator'",
			)
			.first(),
	).toMatchObject({
		enabled: 1,
		rollout_percent: 25,
		audience: 'everyone',
		updated_by: 1,
	})

	await expect(
		adminFeatureFlagSetCapability.handler(
			{ key: 'not-a-real-flag', enabled: true },
			ctx,
		),
	).rejects.toThrow(/Unknown feature flag key/)

	const setByUsername = await adminFeatureFlagOverrideCapability.handler(
		{ key: 'demo-indicator', username: 'JANE', enabled: true },
		ctx,
	)
	expect(setByUsername).toMatchObject({
		cleared: false,
		flag: {
			key: 'demo-indicator',
			overrides: [
				expect.objectContaining({
					stableUserId: testStableUserIdFromEmail('jane@example.com'),
					username: 'jane',
					enabled: true,
				}),
			],
		},
	})
	expect(
		await db
			.prepare(
				"SELECT enabled, updated_by FROM feature_flag_user_overrides WHERE flag_key = 'demo-indicator' AND user_id = 2",
			)
			.first(),
	).toMatchObject({
		enabled: 1,
		updated_by: 1,
	})

	const cleared = await adminFeatureFlagOverrideCapability.handler(
		{
			key: 'demo-indicator',
			stableUserId: testStableUserIdFromEmail('jane@example.com'),
			clear: true,
		},
		ctx,
	)
	expect(cleared.cleared).toBe(true)
	expect(cleared.flag.overrides).toEqual([])
	expect(
		Boolean(
			await db
				.prepare(
					"SELECT enabled FROM feature_flag_user_overrides WHERE flag_key = 'demo-indicator' AND user_id = 2",
				)
				.first(),
		),
	).toBe(false)

	expect(
		(
			await audit.reader
				.prepare('SELECT result FROM audit_events ORDER BY id')
				.all<{ result: string }>()
		).results.map((event) => event.result),
	).toEqual(['success', 'success', 'failure', 'success', 'success'])
})
