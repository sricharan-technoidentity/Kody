import { type AwsEnv } from '../aws/env.ts'
import { runErrorRecordedTopic } from '#worker/run-records/package-subscriptions.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { upsertJobSchedule } from './schedules.ts'
import { type EventFanout } from './workflows/event-fanout.ts'
import { type JobRun } from './workflows/job-run.ts'

async function waitFor<T>(read: () => Promise<T | undefined>, label: string) {
	const deadline = Date.now() + 15_000
	for (;;) {
		const value = await read()
		if (value !== undefined) return value
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for ${label}.`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

/**
 * A Schedule fire for `job:{userId}:{jobId}`: writes the job's Schedule (a
 * one-shot at `scheduledAt`), triggers it the way the Schedule fires, and
 * follows the run into the `run.error.recorded` fan-out when it fails.
 */
export async function runJob(input: {
	env: AwsEnv
	userId: string
	jobId: string
	scheduledAt: string
}): Promise<{
	scheduleId: string
	workflowId: string
	eventId?: string
	eventType?: string
	subscriberRunId?: string
}> {
	const client = await input.env.TEMPORAL.client(taskQueues.runtime)
	const schedule = await upsertJobSchedule(client, {
		userId: input.userId,
		jobId: input.jobId,
		schedule: { type: 'once', runAt: input.scheduledAt },
		timezone: 'UTC',
		nextRunAt: input.scheduledAt,
		expiresAt: null,
		paused: false,
	})
	await schedule.trigger()
	const workflowId = await waitFor(async () => {
		const { info } = await schedule.describe()
		return info.recentActions[0]?.action.workflow.workflowId
	}, 'the Schedule to start JobRun')
	const outcome = await client.workflow
		.getHandle<typeof JobRun>(workflowId)
		.result()
	const scheduleId = workflowIds.jobSchedule(input.userId, input.jobId)
	if (outcome.ok) return { scheduleId, workflowId }
	const fanout = await client.workflow
		.getHandle<typeof EventFanout>(
			workflowIds.eventFanout(runErrorRecordedTopic, outcome.runId),
		)
		.result()
	return {
		scheduleId,
		workflowId,
		eventId: fanout.eventId,
		eventType: fanout.topic,
		subscriberRunId: fanout.runs[0]?.runId,
	}
}
