import { expect, test, vi } from 'vitest'
import * as Sentry from '#worker/front-door/telemetry.ts'
import { createTargetTestEnv } from '#worker/test-support/aws/target-test-env.ts'
const target = await createTargetTestEnv()
const env = target.env as unknown as Env
import { afterAll } from 'vitest'
afterAll(() => target.close())
import type * as SystemEmail from '#worker/email/system-email.ts'

const mocks = vi.hoisted(() => ({
	reconcileArtifactsPushes: vi.fn(async () => ({})),
	sweepStaleInboundDeliveries: vi.fn(async () => ({})),
	cleanupRepoSessionBranches: vi.fn(async () => ({})),
	pruneSystemEmailRetention: vi.fn(async () => ({})),
	pruneRetention: vi.fn(async () => ({})),
	pruneJobRetention: vi.fn(async () => ({})),
	checkAuthDenialBurstAndNotify: vi.fn(async () => ({
		status: 'below_threshold',
		count: 0,
	})),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	runCreditDebits: vi.fn(async () => ({
		scanned: 0,
		debitedUsers: 0,
		debitedMicroUsd: 0,
		autoRefilled: 0,
		failed: 0,
		done: true,
	})),
	refreshAdminInsightsRunLogSnapshot: vi.fn(async () => ({
		complete: true,
		snapshotUpdatedAt: '2026-09-10T00:00:00.000Z',
		usersWithRunLog: 0,
		usersMissingRunLog: 0,
		runs: 0,
		medianRunDurationMs: null,
		hours: [],
	})),
	backfillStorageBucketEstimates: vi.fn(async () => ({
		scanned: 0,
		updated: 0,
		failed: 0,
	})),
	reconcileD1StorageBytes: vi.fn(async () => ({
		scanned: 0,
		updated: 0,
		failed: 0,
	})),
}))

vi.mock('./jobs/reconcile-artifacts-pushes.ts', () => ({
	reconcileArtifactsPushes: mocks.reconcileArtifactsPushes,
}))

vi.mock('./repo/repo-session-cleanup.ts', () => ({
	cleanupRepoSessionBranches: mocks.cleanupRepoSessionBranches,
}))

vi.mock('#worker/email/system-email.ts', async (importOriginal) => ({
	...(await importOriginal<typeof SystemEmail>()),
	pruneSystemEmailRetention: mocks.pruneSystemEmailRetention,
}))

vi.mock('#worker/email/reconcile-inbound-deliveries.ts', () => ({
	sweepStaleInboundDeliveries: mocks.sweepStaleInboundDeliveries,
}))

vi.mock('#app/retention.ts', () => ({
	pruneRetention: mocks.pruneRetention,
}))

vi.mock('#worker/jobs/job-retention-cleanup.ts', () => ({
	pruneJobRetention: mocks.pruneJobRetention,
}))

vi.mock('#app/auth-denial-alerts.ts', () => ({
	checkAuthDenialBurstAndNotify: mocks.checkAuthDenialBurstAndNotify,
}))

vi.mock('#worker/usage/aggregate-rollups.ts', () => ({
	aggregateUsageRollups: mocks.aggregateUsageRollups,
}))

vi.mock('#worker/billing/credit-debits.ts', () => ({
	runCreditDebits: mocks.runCreditDebits,
}))

vi.mock('#worker/admin/insights-runlog-snapshot.ts', () => ({
	refreshAdminInsightsRunLogSnapshot: mocks.refreshAdminInsightsRunLogSnapshot,
}))

vi.mock('#worker/storage-buckets/estimate-backfill.ts', () => ({
	backfillStorageBucketEstimates: mocks.backfillStorageBucketEstimates,
}))

vi.mock('#worker/entitlements/d1-storage-reconciliation.ts', () => ({
	d1StorageReconciliationBatchSize: 8,
	reconcileD1StorageBytes: mocks.reconcileD1StorageBytes,
}))

const { runScheduledLane, runScheduledLaneWithFailureIsolation } =
	await import('./scheduled/scheduled-lanes.ts')

const cron = '*/5 * * * *'

function createMessage(lane: string, scheduledTime: number) {
	return {
		lane,
		scheduledTime,
		cron,
	} as Parameters<typeof runScheduledLaneWithFailureIsolation>[0]['message']
}

function getOAuthPurgeCoordinator() {
	return env.OAUTH_PURGE_COORDINATOR.get(
		env.OAUTH_PURGE_COORDINATOR.idFromName('global'),
	)
}

test('platform lanes execute with their expected inputs and jobs-owned lanes are rejected', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:30.000Z')
	const scheduledAt = new Date(scheduledTime)
	for (const lane of [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'repo_session_index_backfill',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'retention',
		'job_retention',
		'usage_aggregation',
		'auth_denial_alert',
	] as const) {
		await runScheduledLane({ env, lane, scheduledAt })
	}

	expect(mocks.reconcileArtifactsPushes).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalledTimes(1)
	expect(mocks.sweepStaleInboundDeliveries).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneSystemEmailRetention).toHaveBeenCalledWith(
		expect.objectContaining({ blobs: env.EMAIL_BLOBS }),
	)
	expect(mocks.aggregateUsageRollups).toHaveBeenCalledWith(env, scheduledAt)
	expect(mocks.runCreditDebits).toHaveBeenCalledWith({
		env,
		now: scheduledAt,
	})
	expect(mocks.refreshAdminInsightsRunLogSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.checkAuthDenialBurstAndNotify).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.backfillStorageBucketEstimates).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneRetention).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneJobRetention).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	await expect(
		runScheduledLane({ env, lane: 'd1_storage_reconciliation', scheduledAt }),
	).rejects.toThrow('retired in the AWS target')

	await expect(
		runScheduledLane({
			env,
			lane: 'job_schedule_watchdog',
			scheduledAt: new Date(),
		}),
	).rejects.toThrow(/owned by the jobs worker/)
})

test('lane failure isolation reports ordinary errors to Sentry and treats PostgreSQL deadlocks as retryable', async () => {
	const consoleErrorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const withScope = vi.spyOn(Sentry, 'withScope')
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
	mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
		new Error('reconcile exploded'),
	)
	const failedTime = Date.parse('2026-07-05T10:10:00.000Z')

	try {
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', failedTime),
			}),
		).resolves.toBe('failed')

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'scheduled_lane_failed lane=reconcile_artifacts_pushes',
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		expect(withScope).toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		const scopeCallback = withScope.mock.calls[0]?.[0] as
			| ((scope: {
					setTag: (key: string, value: string) => void
					setContext: (key: string, value: Record<string, unknown>) => void
			  }) => void)
			| undefined
		expect(scopeCallback).toBeTypeOf('function')
		const setTag = vi.fn()
		const setContext = vi.fn()
		scopeCallback?.({ setTag, setContext })
		expect(setTag).toHaveBeenCalledWith(
			'scheduled.lane',
			'reconcile_artifacts_pushes',
		)
		expect(setContext).toHaveBeenCalledWith(
			'scheduled',
			expect.objectContaining({
				lane: 'reconcile_artifacts_pushes',
				scheduledTime: new Date(failedTime).toISOString(),
				cron,
			}),
		)

		captureException.mockClear()
		mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
			Object.assign(new Error('deadlock detected'), { code: '40P01' }),
		)
		const lockTime = Date.parse('2026-07-05T10:20:00.000Z')
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', lockTime),
			}),
		).resolves.toBe('d1_lock_contention')

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'scheduled_lane_d1_lock_contention lane=reconcile_artifacts_pushes',
			expect.objectContaining({
				message: 'deadlock detected',
			}),
		)
		expect(captureException).not.toHaveBeenCalled()
	} finally {
		consoleErrorSpy.mockRestore()
		consoleWarnSpy.mockRestore()
		withScope.mockRestore()
		captureException.mockRestore()
	}
})
