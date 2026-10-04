import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { dailyEntitlementResources } from '#worker/entitlements/user-meter-client.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const mockModule = vi.hoisted(() => ({
	/** Physical payload recompute is entitlements-owned and still SQLite-dialect. */
	calculateUserD1StorageBytes: vi.fn(async () => 0),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		calculateUserD1StorageBytes: (...args: Array<unknown>) =>
			mockModule.calculateUserD1StorageBytes(...args),
	}
})

const { loadAdminUserMeterParityReport } =
	await import('./user-meter-parity.ts')

const stableUserId = testStableUserIdFromEmail('parity@example.com')
const now = new Date('2026-08-01T12:00:00.000Z')
const day = utcDayKey(now)

async function createParityTestDb(input: { deletingAt?: string | null } = {}) {
	const database = await createTestDb()
	await database.pg.query(
		`INSERT INTO users (stable_user_id, username, email, password_hash, deleting_at)
		 VALUES ($1, 'parity-user', 'parity@example.com', 'x', $2)`,
		[stableUserId, input.deletingAt ?? null],
	)
	return {
		...database,
		// The operator capability reads one account through that account's scoped reader.
		readerFor: (userId: string) =>
			database.forUser(userId).reader as unknown as SqlDatabase,
	}
}

async function initializeDailyCounters(input: {
	meter: ReturnType<typeof createInMemoryUserMeterEnv>
	counts: Record<(typeof dailyEntitlementResources)[number], number>
}) {
	const meter = userMeterRpc({ env: input.meter.env, userId: stableUserId })
	for (const resource of dailyEntitlementResources) {
		await meter.initialize({
			resource,
			day,
			count: input.counts[resource],
			updatedAt: now.toISOString(),
		})
	}
}

function assertNoLeaseSecrets(value: unknown) {
	const serialized = JSON.stringify(value)
	expect(serialized).not.toContain('"token"')
	expect(serialized).not.toContain('"holder"')
}

test('loadAdminUserMeterParityReport verifies daily, storage, and deletion state without liveness D1 tables', async () => {
	await using database = await createParityTestDb()
	const db = database.readerFor(stableUserId)
	const meter = createInMemoryUserMeterEnv()
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	mockModule.calculateUserD1StorageBytes.mockResolvedValue(4096)
	await initializeDailyCounters({
		meter,
		counts: {
			email_sends_per_day: 3,
			email_receives_per_day: 5,
			execute_calls_per_day: 11,
			outbound_fetches_per_day: 7,
			job_runs_per_day: 0,
			automation_invocations_per_day: 0,
		},
	})
	await meterStub.initializeStorageBytes({
		bytes: 4096,
		updatedAt: now.toISOString(),
	})
	await meterStub.acquireWriteLease({
		token: 'active-lease-abc123',
		holder: 'holder-xyz789',
		acquiredAt: '2026-08-01T09:00:00.000Z',
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report).toMatchObject({
		generatedAt: now.toISOString(),
		stableUserId,
		daily: { day },
		storage: {
			d1Bytes: 4096,
			meterBytes: 4096,
			needsBootstrap: false,
			delta: 0,
			parity: true,
		},
		deletion: {
			d1DeletingAt: null,
			meterDeletingAt: null,
			deletingAtParity: true,
			activeLeaseCount: 1,
		},
	})
	expect(
		report?.daily.resources.map((row) => [row.resource, row.meterCount]),
	).toEqual([
		['email_sends_per_day', 3],
		['email_receives_per_day', 5],
		['execute_calls_per_day', 11],
		['outbound_fetches_per_day', 7],
		['job_runs_per_day', 0],
		['automation_invocations_per_day', 0],
	])
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport surfaces bootstrap and tombstone mismatch without writing meter state', async () => {
	await using database = await createParityTestDb({
		deletingAt: '2026-08-01T08:00:00.000Z',
	})
	const db = database.readerFor(stableUserId)
	const meter = createInMemoryUserMeterEnv()
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	mockModule.calculateUserD1StorageBytes.mockResolvedValue(100)
	await meterStub.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 2,
		updatedAt: now.toISOString(),
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_receives_per_day',
		),
	).toEqual({
		resource: 'email_receives_per_day',
		meterCount: null,
		needsBootstrap: true,
	})
	expect(report?.storage).toEqual({
		d1Bytes: 100,
		meterBytes: null,
		needsBootstrap: true,
		delta: null,
		parity: false,
	})
	expect(report?.deletion).toEqual({
		d1DeletingAt: '2026-08-01T08:00:00.000Z',
		meterDeletingAt: null,
		deletingAtParity: false,
		activeLeaseCount: 0,
	})
	expect(await meterStub.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})
})

test('loadAdminUserMeterParityReport returns null for missing users and other scopes', async () => {
	await using database = await createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const missing = testStableUserIdFromEmail('missing@example.com')
	await expect(
		loadAdminUserMeterParityReport({
			db: database.readerFor(missing),
			env: meter.env,
			stableUserId: missing,
			now,
		}),
	).resolves.toBeNull()
	// Another account's reader cannot see the target row under RLS.
	await expect(
		loadAdminUserMeterParityReport({
			db: database.readerFor(missing),
			env: meter.env,
			stableUserId,
			now,
		}),
	).resolves.toBeNull()
})
