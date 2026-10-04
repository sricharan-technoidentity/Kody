import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import type * as ExecutionSafety from './execution-safety.ts'
import { expect, test, vi } from 'vitest'
import {
	insertJobRow,
	maxDueJobsPerAlarm,
} from '@kody-internal/shared/jobs/repo.ts'
import { type JobRecord } from '@kody-internal/shared/jobs/types.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { createTestRunRecords } from '#worker/test-support/run-records.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	getJobManagerDebugState,
	purgeJobManagerForUser,
	runJobNowViaManager,
	syncJobManagerAlarm,
} from './manager-client.ts'
import { runDueJobsForUser } from './service.ts'

// Only the sandbox execution is substituted; claims, finalization, metering
// records, PostgreSQL owner scope and Temporal orchestration stay real.
vi.mock('./execution-safety.ts', async (original) => ({
	...(await original<typeof ExecutionSafety>()),
	executeOrReplayScheduledJobRun: vi.fn(async () => ({
		execution: { ok: true, result: 42, logs: [] },
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: 1,
	})),
}))

function job(id: string, userId: string, nextRunAt: string): JobRecord {
	return {
		version: 1,
		id,
		userId,
		name: id,
		sourceId: `source-${id}`,
		publishedCommit: null,
		storageId: `job:${id}`,
		schedule: { type: 'once', runAt: nextRunAt },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: nextRunAt,
		updatedAt: nextRunAt,
		nextRunAt,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
}

async function insert(
	database: Awaited<ReturnType<typeof createTestDb>>,
	record: JobRecord,
) {
	await insertJobRow({
		db: database.forUser(record.userId).db as unknown as SqlDatabase,
		userId: record.userId,
		job: record,
		callerContextJson: 'null',
	})
}

test('a scheduled job beyond the account backlog cap executes only that selected job and still respects the claim guard', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	await database.db
		.prepare(
			'INSERT INTO users (username, email, stable_user_id, password_hash) VALUES (?, ?, ?, ?)',
		)
		.bind('alice', 'alice@example.com', 'alice', 'mock')
		.run()
	const now = new Date()
	for (let index = 0; index < maxDueJobsPerAlarm; index++)
		await insert(
			database,
			job(
				`old-${index}`,
				'alice',
				new Date(now.valueOf() - 120_000 + index).toISOString(),
			),
		)
	await insert(
		database,
		job('selected', 'alice', new Date(now.valueOf() - 1_000).toISOString()),
	)
	await insert(database, {
		...job(
			'future',
			'alice',
			new Date(now.valueOf() + 86_400_000).toISOString(),
		),
	})
	const env = {
		APP_DB: database.db,
		...createTestRunRecords().env,
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const result = await runDueJobsForUser({
		env,
		userId: 'alice',
		jobId: 'selected',
		now,
	})
	expect(result).toMatchObject({
		dueJobCount: 1,
		successCount: 1,
		errorCount: 0,
	})
	expect(result.jobOutcomes.map((outcome) => outcome.jobId)).toEqual([
		'selected',
	])
	expect(
		await database.db
			.prepare(
				'SELECT count(*) AS count FROM jobs WHERE user_id = ? AND claim_token IS NOT NULL',
			)
			.bind('alice')
			.first(),
	).toEqual({ count: 0 })
	expect(
		await runDueJobsForUser({ env, userId: 'alice', jobId: 'future', now }),
	).toMatchObject({ dueJobCount: 0, successCount: 0 })
	expect(
		await runDueJobsForUser({ env, userId: 'alice', jobId: 'selected', now }),
	).toMatchObject({ dueJobCount: 0, successCount: 0 })
})

test('production manager reconciles exact retry and lease wake times, starts manual runs, and purges only the owner', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	const temporal = await createTemporalEnv()
	try {
		const nextRunAt = new Date(Date.now() + 86_400_123).toISOString()
		await insert(database, job('one', 'alice', nextRunAt))
		await insert(database, job('other', 'bob', nextRunAt))
		const env = {
			APP_DB: database.db,
			TEMPORAL: temporal.temporal,
			APP_DB_FOR_USER: (userId: string) => database.forUser(userId).db,
		} as unknown as Env
		const runJob = vi.fn(
			async (input: {
				userId: string
				jobId: string
				scheduledAt: string | null
			}) => ({
				runId: input.jobId,
				ok: true as const,
				output: JSON.stringify({
					job: { id: input.jobId },
					execution: { ok: true, logs: [] },
					deletedAfterRun: false,
				}),
			}),
		)
		const rearmJobSchedules = vi
			.fn(async ({ userId }: { userId: string }) => {
				await syncJobManagerAlarm({ env, userId })
			})
			.mockRejectedValueOnce(new Error('Temporary Schedule service outage.'))
		await temporal.startWorkers({
			queues: ['runtime'],
			activities: { runJob, rearmJobSchedules },
		})
		await syncJobManagerAlarm({ env, userId: 'alice' })
		await syncJobManagerAlarm({ env, userId: 'bob' })
		expect(
			await getJobManagerDebugState({ env, userId: 'alice' }),
		).toMatchObject({
			status: 'armed',
			alarmInSync: true,
			nextRunnableJobId: 'one',
		})
		const handle = temporal.client.schedule.getHandle('job:alice:one')
		expect((await handle.describe()).info.nextActionTimes[0]?.valueOf()).toBe(
			Math.ceil(Date.parse(nextRunAt) / 1_000) * 1_000,
		)
		const retryAt = new Date(Date.parse(nextRunAt) + 30_000).toISOString()
		await database.db
			.prepare('UPDATE jobs SET next_run_at = ? WHERE id = ?')
			.bind(retryAt, 'one')
			.run()
		await syncJobManagerAlarm({ env, userId: 'alice' })
		expect((await handle.describe()).info.nextActionTimes[0]?.valueOf()).toBe(
			Math.ceil(Date.parse(retryAt) / 1_000) * 1_000,
		)
		const leaseExpiresAt = new Date(Date.parse(retryAt) + 600_000).toISOString()
		await database.db
			.prepare(
				'UPDATE jobs SET claim_token = ?, lease_expires_at = ? WHERE id = ?',
			)
			.bind('held', leaseExpiresAt, 'one')
			.run()
		await syncJobManagerAlarm({ env, userId: 'alice' })
		expect((await handle.describe()).info.nextActionTimes[0]?.valueOf()).toBe(
			Math.ceil(Date.parse(leaseExpiresAt) / 1_000) * 1_000,
		)
		expect(
			await getJobManagerDebugState({ env, userId: 'alice' }),
		).toMatchObject({ status: 'armed', alarmInSync: true })
		expect(
			await runJobNowViaManager({ env, userId: 'alice', jobId: 'one' }),
		).toMatchObject({ job: { id: 'one' }, execution: { ok: true } })
		expect(runJob).toHaveBeenLastCalledWith(
			expect.objectContaining({
				userId: 'alice',
				jobId: 'one',
				scheduledAt: null,
			}),
		)
		runJob.mockRejectedValueOnce(
			new Error('Temporary job infrastructure failure.'),
		)
		await expect(
			runJobNowViaManager({ env, userId: 'alice', jobId: 'one' }),
		).rejects.toThrow('Workflow execution failed')
		expect(runJob).toHaveBeenCalledTimes(2)
		expect(rearmJobSchedules).toHaveBeenCalledTimes(2)
		expect(rearmJobSchedules).toHaveBeenLastCalledWith({ userId: 'alice' })
		expect(
			await getJobManagerDebugState({ env, userId: 'alice' }),
		).toMatchObject({ status: 'armed', alarmInSync: true })
		await purgeJobManagerForUser({ env, userId: 'alice' })
		await expect(handle.describe()).rejects.toThrow('schedule not found')
		expect(
			(await temporal.client.schedule.getHandle('job:bob:other').describe())
				.state.paused,
		).toBe(false)
		expect(
			await database
				.forUser('alice')
				.db.prepare('SELECT count(*) AS count FROM jobs')
				.first(),
		).toEqual({ count: 0 })
		expect(
			await database
				.forUser('bob')
				.db.prepare('SELECT count(*) AS count FROM jobs')
				.first(),
		).toEqual({ count: 1 })
	} finally {
		await temporal.close()
	}
}, 30_000)
