import {
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
} from '@temporalio/client'
import { taskQueues } from '#worker/temporal/ids.ts'
import { jobScheduleSpec } from '#worker/temporal/schedules.ts'

export async function scheduleMailboxMaintenance(
	env: Env,
	userId: string,
	atMs: number | null,
) {
	if (!env.TEMPORAL) return
	const client = await env.TEMPORAL.client(taskQueues.platform)
	const scheduleId = `mailbox-maintenance:${userId}`
	const handle = client.schedule.getHandle(scheduleId)
	if (atMs === null) {
		try {
			await handle.delete()
		} catch (error) {
			if (!(error instanceof ScheduleNotFoundError)) throw error
		}
		return
	}
	const options = {
		spec: jobScheduleSpec({
			schedule: { type: 'once', runAt: new Date(atMs).toISOString() },
			timezone: 'UTC',
			nextRunAt: new Date(Math.max(atMs, Date.now() + 1000)).toISOString(),
			expiresAt: null,
		}),
		action: {
			type: 'startWorkflow' as const,
			workflowType: 'MailboxMaintenance',
			workflowId: scheduleId,
			taskQueue: taskQueues.platform,
			args: [{ userId }],
		},
		policies: { overlap: 'BUFFER_ONE' as const, catchupWindow: '10 minutes' },
		state: { remainingActions: 1 },
	}
	try {
		await client.schedule.create({ scheduleId, ...options })
	} catch (error) {
		if (!(error instanceof ScheduleAlreadyRunning)) throw error
		await handle.update(() => options)
	}
}
