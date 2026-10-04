import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { markAccountDeleting } from '#worker/account/deletion-state.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminAccountDeletionAbortCapability } =
	await import('./admin-account-deletion-abort.ts')

const stableUserId = testStableUserIdFromEmail('abort-fence@example.com')
const abortReason = 'Leftover fence after a failed brand-new account delete.'

async function createCapabilityTestDb() {
	const sqlite = await createTestPg()
	await sqlite.exec(`

		INSERT INTO users (stable_user_id, username, email, password_hash)
		VALUES ('${stableUserId}', 'abort-fence', 'abort-fence@example.com', 'hash');
	`)
	return {
		sqlite,
		db: createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
	}
}

function createAdminContext(
	db: SqlDatabase,
	meterEnv: ReturnType<typeof createInMemoryUserMeterEnv>['env'],
) {
	return {
		env: {
			APP_DB: db,
			...meterEnv,
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

test('adminAccountDeletionAbort clears D1 and UserMeter fences', async () => {
	const { sqlite, db } = await createCapabilityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	const ctx = createAdminContext(db, meter.env)

	await markAccountDeleting({
		db,
		dbUserId: 1,
		now: new Date('2026-08-31T15:22:12.000Z'),
		env: meter.env,
	})
	expect(
		await pgQuery(sqlite).get(`SELECT deleting_at FROM users WHERE id = 1`),
	).toEqual({ deleting_at: '2026-08-31 15:22:12' })
	expect(await meterStub.readDeletionState()).toEqual({
		deletingAt: '2026-08-31 15:22:12',
	})

	const result = await adminAccountDeletionAbortCapability.handler(
		{
			stable_user_id: stableUserId,
			reason: abortReason,
		},
		ctx,
	)
	expect(result).toEqual({ aborted: true })
	expect(
		await pgQuery(sqlite).get(`SELECT deleting_at FROM users WHERE id = 1`),
	).toEqual({ deleting_at: null })
	expect(await meterStub.readDeletionState()).toEqual({ deletingAt: null })
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminAccountDeletionAbort',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId};reason=${abortReason}`,
		}),
	)
})

test('adminAccountDeletionAbort fails closed for an unknown user', async () => {
	const { db } = await createCapabilityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const ctx = createAdminContext(db, meter.env)
	const missingUserId = testStableUserIdFromEmail('missing@example.com')

	await expect(
		adminAccountDeletionAbortCapability.handler(
			{
				stable_user_id: missingUserId,
				reason: abortReason,
			},
			ctx,
		),
	).rejects.toThrow('User not found.')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminAccountDeletionAbort',
			result: 'failure',
			reason: 'User not found.',
		}),
	)
})
