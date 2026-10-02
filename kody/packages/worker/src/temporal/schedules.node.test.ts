import { expect, test } from 'vitest'
import { computeNextRunAt } from '@kody-internal/shared/jobs/schedule.ts'
import { type JobSchedule } from '@kody-internal/shared/jobs/types.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { deleteSchedule, upsertJobSchedule } from './schedules.ts'

test('job Schedules fire where the jobs table says, and re-upserts replace them in place', async () => {
	const temporal = await createTemporalEnv()
	try {
		const now = new Date()
		const nextFire = async (
			jobId: string,
			schedule: JobSchedule,
			timezone = 'UTC',
		) => {
			const nextRunAt = computeNextRunAt({ schedule, timezone, from: now })
			const handle = await upsertJobSchedule(temporal.client, {
				userId: 'alice',
				jobId,
				schedule,
				timezone,
				nextRunAt,
				expiresAt: null,
				paused: false,
			})
			const { info } = await handle.describe()
			return { nextRunAt, temporal: info.nextActionTimes[0]?.toISOString() }
		}
		for (const [jobId, schedule, timezone] of [
			[
				'cron',
				{ type: 'cron', expression: '30 9 * * 1-5' },
				'America/New_York',
			],
			['interval', { type: 'interval', every: '45m' }, 'UTC'],
			[
				'once',
				{
					type: 'once',
					runAt: new Date(now.valueOf() + 86_400_000)
						.toISOString()
						.replace(/\.\d+Z$/, '.000Z'),
				},
				'UTC',
			],
		] as const) {
			const fire = await nextFire(jobId, schedule, timezone)
			// Temporal fires on whole seconds, never before `nextRunAt`.
			const wholeSecond = new Date(
				Math.ceil(Date.parse(fire.nextRunAt) / 1_000) * 1_000,
			)
			expect({ jobId, fire: fire.temporal }).toEqual({
				jobId,
				fire: wholeSecond.toISOString(),
			})
		}

		const paused = await upsertJobSchedule(temporal.client, {
			userId: 'alice',
			jobId: 'cron',
			schedule: { type: 'cron', expression: '0 * * * *' },
			timezone: 'UTC',
			nextRunAt: now.toISOString(),
			expiresAt: new Date(now.valueOf() + 3_600_000).toISOString(),
			paused: true,
		})
		const described = await paused.describe()
		expect(paused.scheduleId).toBe('job:alice:cron')
		expect(described.state.paused).toBe(true)
		expect(described.spec.endAt).toEqual(new Date(now.valueOf() + 3_600_000))
		expect(described.action).toMatchObject({
			workflowType: 'JobRun',
			workflowId: 'job:alice:cron',
			taskQueue: 'runtime',
			args: [{ userId: 'alice', jobId: 'cron', scheduledAt: null }],
		})
		expect(await deleteSchedule(temporal.client, 'job:alice:cron')).toBe(true)
		expect(await deleteSchedule(temporal.client, 'job:alice:cron')).toBe(false)
	} finally {
		await temporal.close()
	}
})

test('syncing an account pauses disabled jobs and removes orphan schedules without changing another account', async () => {
	const temporal = await createTemporalEnv()
	try {
		const { syncUserJobSchedules } = await import('./schedules.ts')
		const job = {
			id: 'one',
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
			expiresAt: null,
			enabled: true,
			killSwitchEnabled: false,
		} as const
		await syncUserJobSchedules(temporal.client, {
			userId: 'alice',
			jobs: [job],
		})
		await syncUserJobSchedules(temporal.client, { userId: 'bob', jobs: [job] })
		await syncUserJobSchedules(temporal.client, {
			userId: 'alice',
			jobs: [{ ...job, enabled: false }],
		})
		expect(
			(await temporal.client.schedule.getHandle('job:alice:one').describe())
				.state.paused,
		).toBe(true)
		await syncUserJobSchedules(temporal.client, { userId: 'alice', jobs: [] })
		expect(
			(await temporal.client.schedule.getHandle('job:bob:one').describe()).state
				.paused,
		).toBe(false)
		await expect(
			temporal.client.schedule.getHandle('job:alice:one').describe(),
		).rejects.toThrow(Error)
	} finally {
		await temporal.close()
	}
})
