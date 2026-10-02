import { ScheduleNotFoundError } from '@temporalio/client'
import { type RunOutcome } from '#worker/temporal/activities/types.ts'
import { type RunJobNowResult } from '@kody-internal/shared/jobs/rpc.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type JobManagerDebugState,
	type JobManagerDebugStatus,
} from '@kody-internal/shared/jobs/manager-debug.ts'
import { jobsData } from './jobs-data.ts'
import { type JobRepoCheckPolicy } from './types.ts'
import { syncUserJobSchedules } from '#worker/temporal/schedules.ts'
import { getAccountEnv } from '#worker/identity/token-owner-db.ts'
import { taskQueues, workflowIds } from '#worker/temporal/ids.ts'

export { type JobManagerDebugState, type JobManagerDebugStatus }

/** Existing caller surface; durable scheduling belongs to Temporal. */
export async function purgeJobManagerForUser(input: {
	env: Env
	userId: string
}) {
	if (input.env.TEMPORAL) {
		await syncUserJobSchedules(
			await input.env.TEMPORAL.client(taskQueues.runtime),
			{ userId: input.userId, jobs: [] },
		)
	}
	await jobsData(getAccountEnv(input.env, input.userId)).purgeUserJobsData({
		userId: input.userId,
	})
	return {
		ok: true as const,
		userId: input.userId,
		purged: Boolean(input.env.TEMPORAL),
	}
}

export async function syncJobManagerAlarm(input: { env: Env; userId: string }) {
	if (!input.env.TEMPORAL)
		return { ok: true as const, userId: input.userId, nextRunAt: null }
	const jobs = await jobsData(
		getAccountEnv(input.env, input.userId),
	).listJobsForUser({
		userId: input.userId,
	})
	await syncUserJobSchedules(
		await input.env.TEMPORAL.client(taskQueues.runtime),
		{
			userId: input.userId,
			wakeOnly: true,
			jobs: jobs.map((row) => ({
				...row.record,
				nextRunAt:
					row.claim_token &&
					row.lease_expires_at &&
					Date.parse(row.lease_expires_at) > Date.now()
						? row.lease_expires_at
						: row.record.expiresAt &&
							  Date.parse(row.record.expiresAt) <
									Date.parse(row.record.nextRunAt)
							? row.record.expiresAt
							: row.record.nextRunAt,
			})),
		},
	)
	const next = await jobsData(
		getAccountEnv(input.env, input.userId),
	).getNextRunnableJob({
		userId: input.userId,
		nowIso: new Date().toISOString(),
	})
	return {
		ok: true as const,
		userId: input.userId,
		nextRunAt: next?.schedulerWakeAt ?? null,
	}
}

const missingBindingDebugState: JobManagerDebugState = {
	bindingAvailable: false,
	status: 'missing_binding',
	storedUserId: null,
	alarmScheduledFor: null,
	nextRunnableJobId: null,
	nextRunnableRunAt: null,
	alarmInSync: null,
}

export async function getJobManagerDebugState(input: {
	env: Env
	userId: string
}): Promise<JobManagerDebugState> {
	if (!input.env.TEMPORAL) return missingBindingDebugState
	const next = await jobsData(
		getAccountEnv(input.env, input.userId),
	).getNextRunnableJob({
		userId: input.userId,
		nowIso: new Date().toISOString(),
	})
	if (!next)
		return {
			...missingBindingDebugState,
			bindingAvailable: true,
			storedUserId: input.userId,
			status: 'idle',
			alarmInSync: true,
		}
	const client = await input.env.TEMPORAL.client(taskQueues.runtime)
	let fire: string | null = null
	try {
		const schedule = await client.schedule
			.getHandle(workflowIds.jobSchedule(input.userId, next.id))
			.describe()
		if (!schedule.state.paused)
			fire = schedule.info.nextActionTimes[0]?.toISOString() ?? null
	} catch (error) {
		if (!(error instanceof ScheduleNotFoundError)) throw error
	}
	const synced =
		fire !== null &&
		Date.parse(fire) ===
			Math.ceil(Date.parse(next.schedulerWakeAt) / 1_000) * 1_000
	return {
		bindingAvailable: true,
		storedUserId: input.userId,
		status: synced ? 'armed' : 'out_of_sync',
		alarmScheduledFor: fire,
		nextRunnableJobId: next.id,
		nextRunnableRunAt: next.schedulerWakeAt,
		alarmInSync: synced,
	}
}

export const exportJobManagerForUser = getJobManagerDebugState

export async function runJobNowViaManager(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}) {
	if (!input.env.TEMPORAL)
		throw new Error('Missing TEMPORAL binding for jobs scheduling.')
	const client = await input.env.TEMPORAL.client(taskQueues.runtime)
	const handle = await client.workflow.start('JobRun', {
		workflowId: `${input.userId}:job-now:${input.jobId}:${crypto.randomUUID()}`,
		taskQueue: taskQueues.runtime,
		args: [
			{
				userId: input.userId,
				jobId: input.jobId,
				scheduledAt: null,
				callerContext: input.callerContext,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride,
			},
		],
	})
	const outcome = (await handle.result()) as RunOutcome
	if (!outcome.ok) throw new Error(outcome.error)
	return JSON.parse(outcome.output) as RunJobNowResult
}
