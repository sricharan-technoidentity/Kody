import { expect, test, vi } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { userEmailVerificationStalledTopic } from '#worker/identity/email-verification-stalled-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchUserEmailVerificationStalledSubscriptionEvent: vi.fn(async () => []),
}))

vi.mock(
	'#worker/identity/email-verification-stalled-package-subscriptions.ts',
	() => ({
		dispatchUserEmailVerificationStalledSubscriptionEvent:
			mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	}),
)

const {
	checkEmailVerificationStallsAndNotify,
	shouldRunEmailVerificationStallAlertCron,
} = await import('./email-verification-stall-alerts.ts')

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/** The fleet-wide sweep reads every account, so it runs as `kody_admin`. */
function adminDb(store: TestDb) {
	return createPgDatabase({ connection: store.pg, role: 'kody_admin' })
}

async function seedUser(input: {
	store: TestDb
	username: string
	email: string
	stableUserId: string
	verifiedAt?: string | null
	accountType?: 'person' | 'platform'
	deletingAt?: string | null
	deliveryStatus?: string | null
	deliveryAt?: string | null
}) {
	await input.store.pg.query(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, email_verified_at,
			account_type, deleting_at, email_verification_delivery_status,
			email_verification_delivery_at
		) VALUES ($1, $2, 'hash', $3, $4, $5, $6, $7, $8)`,
		[
			input.username,
			input.email,
			input.stableUserId,
			input.verifiedAt ?? null,
			input.accountType ?? 'person',
			input.deletingAt ?? null,
			input.deliveryStatus ?? null,
			input.deliveryAt ?? null,
		],
	)
}

test('hourly stall scan fans accepted sends older than the threshold and skips fresh or resolved rows', async () => {
	expect(
		shouldRunEmailVerificationStallAlertCron(
			new Date('2026-09-01T10:00:00.000Z'),
		),
	).toBe(true)
	expect(
		shouldRunEmailVerificationStallAlertCron(
			new Date('2026-09-01T10:05:00.000Z'),
		),
	).toBe(false)

	await using store = await createTestDb()
	await seedUser({
		store,
		username: 'raul',
		email: 'a.kodycodes@raulg.dev',
		stableUserId: 'r'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:45:16.921Z',
	})
	await seedUser({
		store,
		username: 'fresh',
		email: 'fresh@example.com',
		stableUserId: 'f'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T09:30:00.000Z',
	})
	await seedUser({
		store,
		username: 'verified',
		email: 'verified@example.com',
		stableUserId: 'v'.repeat(64),
		verifiedAt: '2026-09-01T09:00:00.000Z',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		store,
		username: 'bounced',
		email: 'bounced@example.com',
		stableUserId: 'b'.repeat(64),
		deliveryStatus: 'bounced',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		store,
		username: 'platform',
		email: 'ops@kody.codes',
		stableUserId: 'p'.repeat(64),
		accountType: 'platform',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		store,
		username: 'leaving',
		email: 'leaving@example.com',
		stableUserId: 'l'.repeat(64),
		deletingAt: '2026-09-01T09:00:00.000Z',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})

	const now = new Date('2026-09-01T10:00:00.000Z')
	// An ordinary writer's RLS scope holds no other account to alert on.
	await expect(
		checkEmailVerificationStallsAndNotify({
			env: { APP_DB: store.db, APP_BASE_URL: 'https://kody.codes' },
			now,
		}),
	).resolves.toEqual({ scanned: 0, notified: 0, failed: 0 })
	const env = { APP_DB: adminDb(store), APP_BASE_URL: 'https://kody.codes' }
	const result = await checkEmailVerificationStallsAndNotify({ env, now })

	expect(result).toEqual({ scanned: 1, notified: 1, failed: 0 })
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	).toHaveBeenCalledOnce()
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	).toHaveBeenCalledWith({
		env,
		event: expect.objectContaining({
			event: userEmailVerificationStalledTopic,
			user: {
				id: 'r'.repeat(64),
				username: 'raul',
				email: 'a.kodycodes@raulg.dev',
			},
			status: 'accepted',
			accepted_at: '2026-09-01T08:45:16.921Z',
			stall_after_minutes: 60,
			admin_user_url: `https://kody.codes/admin/users/${'r'.repeat(64)}`,
			occurred_at: '2026-09-01T10:00:00.000Z',
		}),
	})
})

function createMemoryKv() {
	const store = new Map<string, string>()
	return {
		async get(key: string) {
			return store.get(key) ?? null
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace
}

test('hourly stall scan advances a watermark so later accepted sends are not starved', async () => {
	await using store = await createTestDb()
	await seedUser({
		store,
		username: 'older',
		email: 'older@example.com',
		stableUserId: 'a'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T07:00:00.000Z',
	})
	await seedUser({
		store,
		username: 'newer',
		email: 'newer@example.com',
		stableUserId: 'n'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	const env = {
		APP_DB: adminDb(store),
		APP_BASE_URL: 'https://kody.codes',
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
	}
	const first = await checkEmailVerificationStallsAndNotify({
		env,
		now: new Date('2026-09-01T10:00:00.000Z'),
		scanLimit: 1,
	})
	expect(first).toEqual({ scanned: 1, notified: 1, failed: 0 })
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent.mock.calls.at(
			-1,
		)?.[0].event.user.username,
	).toBe('older')

	const second = await checkEmailVerificationStallsAndNotify({
		env,
		now: new Date('2026-09-01T11:00:00.000Z'),
		scanLimit: 1,
	})
	expect(second).toEqual({ scanned: 1, notified: 1, failed: 0 })
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent.mock.calls.at(
			-1,
		)?.[0].event.user.username,
	).toBe('newer')
})
