import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { seedSavedPackage } from '#worker/test-support/aws/user-test-env.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	gatherUsageCampaignSnapshot,
	isStripePaidPlan,
	isStrongRecentUse,
	type UsageCampaignCandidate,
} from './campaign-inputs.ts'
import {
	campaignClientLabel,
	isPackagedSingleClientTrialCtaLive,
} from './campaign-states.ts'

test('campaign inputs treat Stripe Standard/Pro as paid and require execute depth for strong use', () => {
	expect(isStripePaidPlan('standard')).toBe(true)
	expect(isStripePaidPlan('pro')).toBe(true)
	expect(isStripePaidPlan('free')).toBe(false)
	expect(isStripePaidPlan('max')).toBe(false)
	expect(isStripePaidPlan(null)).toBe(false)

	const now = new Date('2026-09-07T12:00:00.000Z')
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: '2026-09-02T00:00:00.000Z',
			executeCount: 3,
			now,
		}),
	).toBe(true)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: '2026-09-02T00:00:00.000Z',
			executeCount: 2,
			now,
		}),
	).toBe(false)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-08-01T00:00:00.000Z',
			firstExecuteAt: '2026-08-01T00:00:00.000Z',
			executeCount: 20,
			now,
		}),
	).toBe(false)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: null,
			executeCount: 10,
			now,
		}),
	).toBe(false)

	expect(campaignClientLabel(null)).toBe('your agent')
	expect(campaignClientLabel('Cursor')).toBe('Cursor')
	expect(isPackagedSingleClientTrialCtaLive({})).toBe(true)
	expect(
		isPackagedSingleClientTrialCtaLive({
			grantedAt: '2026-09-01T00:00:00.000Z',
			expiresAt: '2026-09-15T00:00:00.000Z',
			now: new Date('2026-09-07T12:00:00.000Z'),
		}),
	).toBe(false)
})

test('near-cap reads use Standard overlays, not the stored free plan', async () => {
	// The campaign reads one account on that account's own writer.
	await using database = await createTestDb({ userId: 'user-stock' })
	const db = database.db
	await database.pg.query(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id,
			plan, account_type
		) VALUES ('stock', 'stock@example.com', 'x', $1, 'user-stock', 'free', 'person')`,
		['2026-09-01T00:00:00.000Z'],
	)
	// Free 80% of 10 packages is 8; Standard 80% of 50 is 40.
	for (let i = 0; i < 8; i += 1) {
		await seedSavedPackage(database.pg, {
			id: `pkg-${i}`,
			userId: 'user-stock',
			kodyId: `pkg-${i}`,
		})
	}

	const now = new Date('2026-09-07T12:00:00.000Z')
	const env = {
		APP_DB: db,
		JOBS: {
			listJobsForUser: async () => [],
		},
	} as unknown as Env
	const baseUser: UsageCampaignCandidate = {
		stable_user_id: 'user-stock',
		username: 'stock',
		email: 'stock@example.com',
		email_verified_at: '2026-09-01T00:00:00.000Z',
		first_mcp_connected_at: null,
		first_saved_package_at: '2026-09-02T00:00:00.000Z',
		first_execute_at: null,
		mcp_client_name: null,
		last_active_at: null,
		second_agent_standard_gift_granted_at: null,
		second_agent_standard_gift_expires_at: null,
		referral_standard_credit_expires_at: null,
		plan: 'free',
		stripe_plan: null,
		entitlement_ladder: null,
	}

	expect(
		(
			await gatherUsageCampaignSnapshot({
				env,
				user: baseUser,
				now,
			})
		).isNearEntitlementCap,
	).toBe(true)
	expect(
		(
			await gatherUsageCampaignSnapshot({
				env,
				user: {
					...baseUser,
					second_agent_standard_gift_granted_at: '2026-09-01T00:00:00.000Z',
					second_agent_standard_gift_expires_at: '2026-09-15T00:00:00.000Z',
				},
				now,
			})
		).isNearEntitlementCap,
	).toBe(false)
	expect(
		(
			await gatherUsageCampaignSnapshot({
				env,
				user: {
					...baseUser,
					second_agent_standard_gift_granted_at: '2026-08-01T00:00:00.000Z',
					second_agent_standard_gift_expires_at: '2026-08-15T00:00:00.000Z',
				},
				now,
			})
		).isNearEntitlementCap,
	).toBe(true)
	expect(
		(
			await gatherUsageCampaignSnapshot({
				env,
				user: {
					...baseUser,
					referral_standard_credit_expires_at: '2026-10-01T00:00:00.000Z',
				},
				now,
			})
		).isNearEntitlementCap,
	).toBe(false)
	expect(
		(
			await gatherUsageCampaignSnapshot({
				env,
				user: {
					...baseUser,
					referral_standard_credit_expires_at: '2026-08-01T00:00:00.000Z',
				},
				now,
			})
		).isNearEntitlementCap,
	).toBe(true)
})

test('execute rollup failures do not look like zero use', async () => {
	consoleWarn.mockImplementation(() => {})
	await using database = await createTestDb({ userId: 'user-exec' })
	const db = database.db
	const failingDb = {
		prepare(query: string) {
			if (query.includes('usage_rollups')) {
				throw new Error('rollup down')
			}
			return db.prepare(query)
		},
	}
	const now = new Date('2026-09-07T12:00:00.000Z')
	const snapshot = await gatherUsageCampaignSnapshot({
		env: {
			APP_DB: failingDb,
			JOBS: {
				listJobsForUser: async () => [],
			},
		} as unknown as Env,
		user: {
			stable_user_id: 'user-exec',
			username: 'exec',
			email: 'exec@example.com',
			email_verified_at: '2026-09-01T00:00:00.000Z',
			first_mcp_connected_at: '2026-09-02T00:00:00.000Z',
			first_saved_package_at: '2026-09-03T00:00:00.000Z',
			first_execute_at: '2026-09-03T00:00:00.000Z',
			mcp_client_name: null,
			last_active_at: '2026-09-06T00:00:00.000Z',
			second_agent_standard_gift_granted_at: null,
			second_agent_standard_gift_expires_at: null,
			referral_standard_credit_expires_at: null,
			plan: 'free',
			stripe_plan: null,
			entitlement_ladder: null,
		},
		now,
	})
	expect(snapshot.executeReadFailed).toBe(true)
	expect(snapshot.hasStrongRecentUse).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-execute-read-failed',
		expect.any(Error),
	)
})
