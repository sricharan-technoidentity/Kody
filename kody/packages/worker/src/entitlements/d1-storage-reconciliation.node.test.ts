import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { reconcileD1StorageBytes } from './d1-storage-reconciliation.ts'
import {
	calculateUserD1StorageBytes,
	reconcileUserD1StorageBytes,
} from './service.ts'
import { type UserMeterEnv, type UserMeterRpc } from './user-meter-client.ts'

/** Operator sweep env: lists as `kody_admin`, reads each account on its writer. */
async function createReconcileHarness(userIds: Array<string>) {
	const database = await createTestDb()
	const meter = createInMemoryUserMeterEnv()
	for (const [index, userId] of userIds.entries()) {
		await database.pg.query(
			`INSERT INTO users (stable_user_id, username, email, password_hash)
			 VALUES ($1, $2, $3, 'x')`,
			[userId, `reconcile-${index}`, `reconcile-${index}@example.test`],
		)
	}
	const admin = createPgDatabase({
		connection: database.pg,
		role: 'kody_admin',
	})
	const writerFor = (userId: string) =>
		database.forUser(userId).db as unknown as D1Database
	return {
		database,
		meter,
		admin: admin as unknown as D1Database,
		writerFor,
		envWith(meters: UserMeterEnv = meter.env) {
			return {
				...meters,
				APP_DB_FOR_USER: (userId: string) => database.forUser(userId).db,
			} as UserMeterEnv
		},
		async addPayload(userId: string, size: number) {
			await database.pg.query(
				`INSERT INTO mcp_memories (id, user_id, category, subject, summary, details)
				 VALUES ($1, $2, 'note', 'storage reconciliation', 'tracked payload', $3)`,
				[crypto.randomUUID(), userId, 'x'.repeat(size)],
			)
		},
		async cursor() {
			const { rows } = await database.pg.query<{ position: string }>(
				'SELECT position FROM d1_storage_reconcile_cursor WHERE singleton = 1',
			)
			return rows[0]?.position
		},
		[Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
	}
}

const meterOverride = (stub: Partial<UserMeterRpc>): UserMeterEnv => ({
	USER_METERS: { forUser: () => stub as UserMeterRpc },
})

test('the reconcile lane lists as the operator, sets each meter to its physical bytes and advances the keyset cursor', async () => {
	const first = '1'.repeat(64)
	const second = '1'.repeat(63) + '2'
	const failing = '6'.repeat(64)
	await using harness = await createReconcileHarness([first, second, failing])
	await harness.addPayload(first, 256)
	const expected = await calculateUserD1StorageBytes({
		db: harness.writerFor(first),
		userId: first,
	})
	expect(expected).toBeGreaterThan(256)
	// The operator role cannot read account payload tables at all.
	await expect(
		calculateUserD1StorageBytes({ db: harness.admin, userId: first }),
	).rejects.toThrow(/permission denied/)
	const firstMeter = harness.meter.forUser(first)
	await firstMeter.setStorageBytes({
		bytes: 500_000,
		updatedAt: '2026-07-31T00:00:00.000Z',
	})
	const lane = (env: UserMeterEnv) =>
		reconcileD1StorageBytes({
			db: harness.admin,
			env: harness.envWith(env),
			now: new Date('2026-07-31T01:00:00.000Z'),
			batchSize: 1,
		})

	await expect(lane(harness.meter.env)).resolves.toEqual({
		scanned: 1,
		updated: 1,
		failed: 0,
		deferred: 0,
	})
	expect(await harness.cursor()).toBe(first)
	expect(await firstMeter.readStorageBytes()).toMatchObject({ bytes: expected })

	await lane(harness.meter.env)
	expect(await harness.cursor()).toBe(second)
	expect(await harness.meter.forUser(second).readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 0,
	})

	// A failing meter counts the row as failed; the cursor still advances.
	consoleWarn.mockImplementation(() => {})
	await expect(
		lane(
			meterOverride({
				readStorageBytes: async () => ({ outcome: 'needs_bootstrap' }),
				initializeStorageBytes: async () => {
					throw new Error('UserMeter reconcile failed')
				},
			}),
		),
	).resolves.toEqual({ scanned: 1, updated: 0, failed: 1, deferred: 0 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'd1-storage-reconciliation-row-failed',
		failing,
		expect.any(Error),
	)
	expect(await harness.cursor()).toBe(failing)
})

test('reconcile defers on a CAS miss or a cold-init race and never clobbers a live reservation', async () => {
	const userId = '7'.repeat(64)
	await using harness = await createReconcileHarness([userId])
	await harness.addPayload(userId, 256)
	const db = harness.writerFor(userId)
	const physical = await calculateUserD1StorageBytes({ db, userId })
	const meter = harness.meter.forUser(userId)
	await meter.initializeStorageBytes({
		bytes: 100,
		updatedAt: '2026-08-01T00:00:00.000Z',
	})

	const reserveFirst = meterOverride({
		readStorageBytes: () => meter.readStorageBytes(),
		async reconcileStorageBytes(input) {
			await meter.reserveStorageBytes({
				requested: 50,
				limit: 1_000_000,
				updatedAt: '2026-08-01T00:00:02.000Z',
			})
			return meter.reconcileStorageBytes(input)
		},
	})
	await expect(
		reconcileUserD1StorageBytes({
			db,
			env: reserveFirst,
			userId,
			now: new Date('2026-08-01T01:00:00.000Z'),
		}),
	).resolves.toEqual({ bytes: physical, updated: false, deferred: true })
	expect(await meter.readStorageBytes()).toMatchObject({ bytes: 150 })

	let initCalls = 0
	await expect(
		reconcileUserD1StorageBytes({
			db,
			env: meterOverride({
				readStorageBytes: async () => ({ outcome: 'needs_bootstrap' }),
				async initializeStorageBytes() {
					initCalls += 1
					return {
						outcome: 'ready',
						bytes: 999,
						revision: 3,
						mirrorUpdatedAt: 'r/00000000000000000003',
						created: false,
					}
				},
			}),
			userId,
			now: new Date('2026-08-01T01:00:00.000Z'),
		}),
	).resolves.toEqual({ bytes: physical, updated: false, deferred: true })
	expect(initCalls).toBe(1)

	// A downward correction applies.
	await expect(
		reconcileUserD1StorageBytes({
			db,
			env: harness.meter.env,
			userId,
			now: new Date('2026-08-01T02:00:00.000Z'),
		}),
	).resolves.toEqual({ bytes: physical, updated: true, deferred: false })
	expect(await meter.readStorageBytes()).toMatchObject({ bytes: physical })
})
