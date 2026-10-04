import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { createDynamoUserMeters } from '#worker/aws/dynamo-meters.ts'
import {
	type DailyEntitlementResource,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'

const meterTable = 'kody-test-meters'

/**
 * UserMeter for node tests: the production DynamoDB adapter over the
 * in-memory DynamoDB fake. `dynamo` exposes the raw table for assertions.
 */
export function createInMemoryUserMeterEnv() {
	const dynamo = createFakeDynamo()
	const meters = createDynamoUserMeters({
		region: 'us-east-1',
		tableName: meterTable,
		send: dynamo.send,
	})
	const env = { USER_METERS: meters } satisfies UserMeterEnv
	return {
		env,
		dynamo,
		tableName: meterTable,
		forUser: meters.forUser,
		async seed(input: {
			userId: string
			resource: DailyEntitlementResource
			day: string
			count: number
		}) {
			await meters.forUser(input.userId).initialize({
				resource: input.resource,
				day: input.day,
				count: input.count,
				updatedAt: new Date().toISOString(),
			})
		},
		async seedStorageBytes(input: {
			userId: string
			bytes: number
			updatedAt?: string
		}) {
			await meters.forUser(input.userId).initializeStorageBytes({
				bytes: input.bytes,
				updatedAt: input.updatedAt ?? new Date().toISOString(),
			})
		},
	}
}

export function createWaitUntilDrain() {
	const tasks: Array<Promise<unknown>> = []
	return {
		waitUntil(promise: Promise<unknown>) {
			tasks.push(promise)
		},
		async drain() {
			await Promise.all(tasks)
			tasks.length = 0
		},
	}
}

/**
 * Minimal D1 stub for the `deleting_at` gate used by
 * {@link withAccountWriteLease} in node tests. The DO handles all lease
 * storage; the only D1 query on the hot path is the `deleting_at` point gate.
 */
export function createPermissiveAccountWriteLeaseDbHooks() {
	return {
		supportsDeletingAtQuery(query: string) {
			return query.includes(
				'SELECT deleting_at FROM users WHERE stable_user_id',
			)
		},
		deletingAtFirstResult() {
			return { deleting_at: null as string | null }
		},
	}
}

/**
 * Patch `db.prepare` and restore it via `using` even when the body throws.
 */
export function withPatchedDbPrepare(
	db: SqlDatabase,
	patch: (originalPrepare: SqlDatabase['prepare']) => SqlDatabase['prepare'],
) {
	const originalPrepare = db.prepare.bind(db)
	db.prepare = patch(originalPrepare)
	return {
		[Symbol.dispose]() {
			db.prepare = originalPrepare
		},
	}
}
