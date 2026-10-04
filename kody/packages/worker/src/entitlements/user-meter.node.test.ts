import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { planLimits } from '#universal/plans.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { EntitlementLimitError } from './errors.ts'
import {
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	readDailyEntitlementResourceUsage,
	refundDailyEntitlement,
} from './service.ts'
import { userMeterMirrorUpdatedAtToken } from './user-meter-client.ts'

/** Yesterday 15:00 UTC: inside the seven-day window whatever day the suite runs. */
function recentDailyCounterNow() {
	const now = new Date()
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 15),
	)
}

async function createMeterHarness(prefixes: Array<string>) {
	const database = await createTestDb()
	const meter = createInMemoryUserMeterEnv()
	const users = []
	for (const prefix of prefixes) {
		const email = `${prefix}@example.com`
		const userId = testStableUserIdFromEmail(email)
		await database.pg.query(
			`INSERT INTO users (stable_user_id, username, email, password_hash, plan)
			 VALUES ($1, $2, $3, 'x', 'free')`,
			[userId, prefix, email],
		)
		users.push({
			email,
			userId,
			db: database.forUser(userId).reader as unknown as SqlDatabase,
			meter: meter.forUser(userId),
		})
	}
	return { database, meter, env: meter.env, users }
}

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)

test('UserMeter on DynamoDB: cold bootstrap, per-user daily consume/refund, concurrency, week limits, export and purge', async () => {
	const { database, env, meter, users } = await createMeterHarness([
		'meter-a',
		'meter-b',
	])
	await using _database = database
	const [a, b] = users as [(typeof users)[0], (typeof users)[0]]
	const now = recentDailyCounterNow()
	const day = utcDayKey(now)
	const at = now.toISOString()
	const consume = (user: typeof a, resource = 'email_sends_per_day' as const) =>
		consumeDailyEntitlement({
			db: user.db,
			env,
			userId: user.userId,
			email: user.email,
			resource,
			now,
		})

	expect(
		await a.meter.read({ resource: 'email_sends_per_day', day, now: at }),
	).toEqual({ outcome: 'needs_bootstrap' })
	await consume(a)
	expect(
		await a.meter.read({ resource: 'email_sends_per_day', day, now: at }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	// The next UTC day starts cold and independent.
	const nextDay = new Date(now.getTime() + 10 * 60 * 60 * 1000)
	expect(
		await a.meter.read({
			resource: 'email_sends_per_day',
			day: utcDayKey(nextDay),
			now: nextDay.toISOString(),
		}),
	).toEqual({ outcome: 'needs_bootstrap' })

	const sendLimit = planLimits.free.maxEmailSendsPerDay
	for (let index = 1; index < sendLimit; index += 1) await consume(a)
	const concurrent = await Promise.all(
		Array.from({ length: 8 }, () => failure(consume(a))),
	)
	expect(
		concurrent.every((error) => error instanceof EntitlementLimitError),
	).toBe(true)
	await consume(b)
	expect(
		await b.meter.read({ resource: 'email_sends_per_day', day, now: at }),
	).toMatchObject({ count: 1 })
	expect(
		await readDailyEntitlementResourceUsage({
			env,
			userId: a.userId,
			resource: 'email_sends_per_day',
			now,
		}),
	).toBe(sendLimit)
	for (let index = 0; index <= sendLimit; index += 1) {
		await refundDailyEntitlement({
			env,
			userId: a.userId,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(
		await a.meter.read({ resource: 'email_sends_per_day', day, now: at }),
	).toMatchObject({ outcome: 'ready', count: 0 })

	// Concurrent consumes race on the revision CAS and never overshoot.
	await a.meter.initialize({
		resource: 'job_runs_per_day',
		day,
		count: 0,
		updatedAt: at,
	})
	const raced = await Promise.all(
		Array.from({ length: 12 }, () =>
			a.meter.consume({
				resource: 'job_runs_per_day',
				day,
				limit: 5,
				updatedAt: at,
			}),
		),
	)
	expect(
		raced.filter((result) => 'consumed' in result && result.consumed),
	).toHaveLength(5)
	expect(
		await a.meter.read({ resource: 'job_runs_per_day', day, now: at }),
	).toMatchObject({
		count: 5,
		revision: 6,
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(6),
	})

	// A full week denies before the day does.
	const monday = '2026-07-06'
	const wednesday = new Date('2026-07-08T15:00:00.000Z')
	for (const [counterDay, count] of [
		[monday, 150],
		['2026-07-07', 150],
		['2026-07-08', 99],
	] as const) {
		await b.meter.initialize({
			resource: 'execute_calls_per_day',
			day: counterDay,
			count,
			updatedAt: wednesday.toISOString(),
		})
	}
	expect(
		await b.meter.readRange({
			resource: 'execute_calls_per_day',
			startDay: monday,
			endDay: '2026-07-08',
			now: wednesday.toISOString(),
		}),
	).toEqual({ outcome: 'ready', count: 399 })
	const executeB = () =>
		consumeDailyEntitlement({
			db: b.db,
			env,
			userId: b.userId,
			email: b.email,
			resource: 'execute_calls_per_day',
			now: wednesday,
		})
	await executeB()
	expect(
		((await failure(executeB())) as EntitlementLimitError).details,
	).toMatchObject({
		resource: 'execute_calls_per_day',
		limit: 400,
		current: 400,
		window: 'week',
	})

	// Rows outside the retention window read as absent and can be re-seeded.
	expect(
		await b.meter.claimDynamicWorkerDay({
			workerId: 'kody-worker-a',
			day,
			createdAt: at,
		}),
	).toEqual({ created: true })
	expect(
		await b.meter.claimDynamicWorkerDay({
			workerId: 'kody-worker-a',
			day,
			createdAt: at,
		}),
	).toEqual({ created: false })
	expect(
		await b.meter.read({
			resource: 'execute_calls_per_day',
			day: '2026-07-08',
			now: at,
		}),
	).toEqual({ outcome: 'needs_bootstrap' })
	await expect(
		a.meter.consume({
			resource: 'email_sends_per_day',
			day: 'not-a-day',
			limit: 1,
			updatedAt: at,
		}),
	).rejects.toThrow(/UTC YYYY-MM-DD/)

	await a.meter.initialize({
		resource: 'execute_calls_per_day',
		day,
		count: 2,
		updatedAt: at,
	})
	const exported = await a.meter.exportCounters({ pageSize: 2 })
	expect(exported.counters.map((row) => [row.resource, row.count])).toEqual([
		['email_sends_per_day', 0],
		['execute_calls_per_day', 2],
	])
	expect(exported.truncated).toBe(true)
	const rest = await a.meter.exportCounters({
		pageSize: 2,
		startAfter: exported.nextStartAfter,
	})
	expect(rest.counters.map((row) => row.resource)).toEqual(['job_runs_per_day'])
	expect(rest.storageBytesState).toBeNull()

	await expect(a.meter.purge()).resolves.toEqual({ ok: true })
	expect(await a.meter.exportCounters({})).toEqual({
		counters: [],
		storageBytesState: null,
		deletionState: {
			deletingAt: null,
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		inboundConnectionLastUsed: [],
		nextStartAfter: null,
		truncated: false,
	})
	expect(
		await b.meter.read({ resource: 'email_sends_per_day', day, now: at }),
	).toMatchObject({ count: 1 })
	// Every item sits in its owner's partition under the `counter#day` sort key.
	expect(
		meter.dynamo
			.items(meter.tableName)
			.filter((item) => item.pk?.S === b.userId)
			.map((item) => item.sk?.S),
	).toEqual(
		expect.arrayContaining([
			`email_sends_per_day#${day}`,
			`dynamic_worker#${day}#kody-worker-a`,
		]),
	)
})

test('UserMeter storage bytes: cold bootstrap, denial, concurrent reserves, export state and missing users', async () => {
	const { database, env, users } = await createMeterHarness([
		'meter-storage',
		'meter-storage-concurrent',
	])
	await using _database = database
	const [user, concurrent] = users as [(typeof users)[0], (typeof users)[0]]
	const storageLimit = planLimits.free.maxStorageBytes
	const reserve = (target: typeof user, requested: number) =>
		assertWithinStorageBytesEntitlement({
			db: target.db,
			env,
			userId: target.userId,
			email: target.email,
			requested,
		})

	await reserve(user, 5)
	expect(await user.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 5,
	})
	expect(await failure(reserve(user, storageLimit - 4))).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: 5,
		},
	})

	await concurrent.meter.initializeStorageBytes({
		bytes: storageLimit - 10,
		updatedAt: '2026-07-31T15:00:00.000Z',
	})
	const attempts = await Promise.all(
		Array.from({ length: 20 }, () => failure(reserve(concurrent, 5))),
	)
	expect(attempts.filter((result) => result === null)).toHaveLength(2)
	expect(
		attempts.filter((result) => result instanceof EntitlementLimitError),
	).toHaveLength(18)
	expect(await concurrent.meter.readStorageBytes()).toMatchObject({
		bytes: storageLimit,
	})

	// No account row: free-plan semantics and no durable meter state.
	const missing = {
		...user,
		userId: 'a'.repeat(64),
		email: null as unknown as string,
		db: database.forUser('a'.repeat(64)).reader as unknown as SqlDatabase,
	}
	await expect(reserve(missing, 1)).resolves.toBeUndefined()
	expect(await failure(reserve(missing, storageLimit + 1))).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: 0,
		},
	})

	const meter = user.meter
	await meter.setStorageBytes({
		bytes: 11,
		updatedAt: '2026-07-31T17:02:00.000Z',
	})
	expect(
		await meter.reconcileStorageBytes({
			bytes: 99,
			expectedRevision: 1,
			updatedAt: '2026-07-31T17:03:00.000Z',
		}),
	).toMatchObject({ applied: false, bytes: 11 })
	expect((await meter.exportCounters({})).storageBytesState).toEqual({
		bytes: 11,
		revision: 3,
		updatedAt: '2026-07-31T17:02:00.000Z',
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(3),
	})
	expect(
		await meter.reconcileStorageBytes({
			bytes: 7,
			expectedRevision: 3,
			updatedAt: '2026-07-31T17:04:00.000Z',
		}),
	).toMatchObject({ applied: true, bytes: 7, revision: 4 })
	await meter.purge()
	expect(await meter.readStorageBytes()).toEqual({ outcome: 'needs_bootstrap' })
})

test('UserMeter deletion tombstone, write leases, repair, inbound delivery claims and MCP last-used', async () => {
	const meters = createInMemoryUserMeterEnv()
	const meterA = meters.forUser('user-a')
	const meterB = meters.forUser('user-b')
	const leaseA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	const leaseB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

	expect(
		await meterA.markDeleting({ deletingAt: '2026-08-01 10:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: true,
		leaseCount: 0,
	})
	expect(
		await meterA.markDeleting({ deletingAt: '2026-08-01 11:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: false,
		leaseCount: 0,
	})
	expect(
		await meterA.clearDeleting({ expectedDeletingAt: '2026-08-01 11:00:00' }),
	).toEqual({ cleared: false })
	expect(await meterA.clearDeleting()).toEqual({ cleared: true })
	expect(await meterA.clearDeleting()).toEqual({ cleared: false })
	await meterA.markDeleting({ deletingAt: '2026-08-01 10:00:00' })

	const acquire = (token: string, acquiredAt: string) =>
		meterB.acquireWriteLease({ token, holder: `test:${token}`, acquiredAt })
	expect(await acquire(leaseA, '2026-08-01 10:05:00')).toEqual({
		acquired: true,
	})
	expect(await acquire(leaseA, '2026-08-01 10:05:00')).toEqual({
		acquired: true,
	})
	expect(await acquire(leaseB, '2026-08-01 10:06:00')).toEqual({
		acquired: true,
	})
	expect(
		await meterB.markDeleting({ deletingAt: '2026-08-01 09:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 09:00:00',
		created: true,
		leaseCount: 2,
	})
	expect(
		await acquire(
			'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
			'2026-08-01 10:07:00',
		),
	).toEqual({ acquired: false })
	// A lease that is already held stays held after the tombstone appears.
	expect(await acquire(leaseA, '2026-08-01 10:05:00')).toEqual({
		acquired: true,
	})
	expect(
		await meterA.acquireWriteLease({
			token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			holder: 'test:blocked',
			acquiredAt: '2026-08-01 10:07:00',
		}),
	).toEqual({ acquired: false })

	const page = await meterB.listWriteLeases({ pageSize: 1 })
	expect(page).toMatchObject({ truncated: true, leases: [{ token: leaseA }] })
	expect(
		await meterB.listWriteLeases({
			pageSize: 10,
			startAfter: page.nextStartAfter,
		}),
	).toMatchObject({
		truncated: false,
		nextStartAfter: null,
		leases: [{ token: leaseB }],
	})
	expect(await meterB.releaseWriteLease({ token: leaseA })).toEqual({
		released: true,
	})
	expect(await meterB.releaseWriteLease({ token: leaseA })).toEqual({
		released: false,
	})

	await expect(
		meterB.prepareWriteLeaseRepair({
			token: leaseB,
			expectedAcquiredAt: 'wrong',
		}),
	).rejects.toThrow('did not match')
	const prepared = await meterB.prepareWriteLeaseRepair({
		token: leaseB,
		expectedAcquiredAt: '2026-08-01 10:06:00',
	})
	if (!prepared.prepared) throw new Error('expected a prepared repair')
	expect(
		await meterB.prepareWriteLeaseRepair({
			token: leaseB,
			expectedAcquiredAt: '2026-08-01 10:06:00',
		}),
	).toMatchObject({ prepared: true, repairId: prepared.repairId })
	expect(await meterB.assertWriteLeaseHeld({ token: leaseB })).toEqual({
		held: true,
	})
	await expect(
		meterB.finalizeWriteLeaseRepair({
			token: leaseB,
			repairId: 'other',
			expectedAcquiredAt: '2026-08-01 10:06:00',
		}),
	).rejects.toThrow('did not match')
	for (let attempt = 0; attempt < 2; attempt++) {
		expect(
			await meterB.finalizeWriteLeaseRepair({
				token: leaseB,
				repairId: prepared.repairId,
				expectedAcquiredAt: '2026-08-01 10:06:00',
			}),
		).toEqual({ finalized: true })
	}
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 0 })

	// Purge clears state but keeps the tombstone.
	await meterA.initialize({
		resource: 'email_sends_per_day',
		day: utcDayKey(),
		count: 1,
		updatedAt: new Date().toISOString(),
	})
	await meterA.purge()
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-01 10:00:00',
	})
	expect((await meterA.exportCounters({})).counters).toEqual([])

	// Inbound delivery: one unit per delivery id, retries replay.
	const day = utcDayKey()
	const updatedAt = new Date().toISOString()
	const delivery = (deliveryId: string, limit = 2) =>
		meterB.consumeInboundDelivery({
			deliveryId,
			resource: 'email_receives_per_day',
			day,
			limit,
			updatedAt,
		})
	expect(await delivery('m1')).toEqual({ outcome: 'needs_bootstrap' })
	await meterB.initialize({
		resource: 'email_receives_per_day',
		day,
		count: 0,
		updatedAt,
	})
	expect(await delivery('m1')).toMatchObject({
		consumed: true,
		replayed: false,
		count: 1,
	})
	expect(await delivery('m1')).toMatchObject({
		consumed: false,
		replayed: true,
		count: 1,
	})
	const both = await Promise.all([delivery('m2'), delivery('m3')])
	expect(
		both.filter((result) => 'consumed' in result && result.consumed),
	).toHaveLength(1)
	await expect(
		meterB.consumeInboundDelivery({
			deliveryId: 'm1',
			resource: 'email_sends_per_day',
			day,
			limit: 2,
			updatedAt,
		}),
	).rejects.toThrow('requires email_receives_per_day')

	// MCP last-used: five-minute debounce, per user, forget and purge.
	const clientId = 'https://cursor.com/oauth/vG4-last-used/client.json'
	const touch = (lastUsedAt: string) =>
		meterB.touchInboundConnectionLastUsed({ clientId, lastUsedAt })
	expect(await touch('2026-03-20T12:00:00.000Z')).toEqual({ updated: true })
	expect(await touch('2026-03-20T12:04:59.000Z')).toEqual({ updated: false })
	expect(await touch('2026-03-20T12:05:01.000Z')).toEqual({ updated: true })
	await meterA.touchInboundConnectionLastUsed({
		clientId: 'other-client',
		lastUsedAt: '2026-03-20T12:05:01.000Z',
	})
	expect(await meterB.listInboundConnectionLastUsed()).toEqual([
		{ clientId, lastUsedAt: '2026-03-20T12:05:01.000Z' },
	])
	expect((await meterB.exportCounters({})).inboundConnectionLastUsed).toEqual([
		{ clientId, lastUsedAt: '2026-03-20T12:05:01.000Z' },
	])
	await meterB.forgetInboundConnectionLastUsed({ clientId })
	expect(await meterB.listInboundConnectionLastUsed()).toEqual([])
	expect(await meterA.listInboundConnectionLastUsed()).toHaveLength(1)
})
