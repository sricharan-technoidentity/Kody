import {
	type Client,
	MONTHS,
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
	type ScheduleOptions,
	type ScheduleSpec,
} from '@temporalio/client'
import { normalizeJobSchedule } from '@kody-internal/shared/jobs/schedule.ts'
import {
	type JobRecord,
	type JobSchedule,
} from '@kody-internal/shared/jobs/types.ts'
import { type JobRunInput } from './activities/types.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { kodySearchAttributes } from './search-attributes.ts'

const intervalUnitMs = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
}

function intervalMs(every: string) {
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(every)
	if (!match) throw new Error(`Invalid interval "${every}".`)
	return (
		Number(match[1]) * intervalUnitMs[match[2] as keyof typeof intervalUnitMs]
	)
}

/**
 * Temporal spec for a job schedule. Crons keep their timezone; intervals are
 * phase-aligned to the job's `nextRunAt`; `once` is one calendar instant in
 * UTC. `startAt` is `nextRunAt` (Temporal fires on whole seconds, so rounded
 * up) and `expiresAt` ends it: fires land where the jobs table says.
 */
export function jobScheduleSpec(input: {
	schedule: JobSchedule
	timezone: string
	nextRunAt: string
	expiresAt: string | null
}): ScheduleSpec {
	const schedule = normalizeJobSchedule(input.schedule)
	const startAt = Math.ceil(Date.parse(input.nextRunAt) / 1_000) * 1_000
	const bounds = {
		startAt: new Date(startAt),
		...(input.expiresAt ? { endAt: new Date(input.expiresAt) } : {}),
	}
	switch (schedule.type) {
		case 'cron':
			return {
				cronExpressions: [schedule.expression],
				timezone: input.timezone,
				...bounds,
			}
		case 'interval': {
			const every = intervalMs(schedule.every)
			return {
				intervals: [{ every, offset: startAt % every }],
				...bounds,
			}
		}
		case 'once': {
			const at = new Date(startAt)
			return {
				calendars: [
					{
						year: at.getUTCFullYear(),
						month: MONTHS[at.getUTCMonth()]!,
						dayOfMonth: at.getUTCDate(),
						hour: at.getUTCHours(),
						minute: at.getUTCMinutes(),
						second: at.getUTCSeconds(),
					},
				],
				...bounds,
			}
		}
	}
}

/**
 * Create or replace the Schedule `job:{userId}:{jobId}`. A disabled or
 * kill-switched job keeps its Schedule, paused, so a re-enable resumes it.
 */
export async function upsertJobSchedule(
	client: Client,
	input: {
		userId: string
		jobId: string
		schedule: JobSchedule
		timezone: string
		nextRunAt: string
		expiresAt: string | null
		paused: boolean
		wakeOnly?: boolean
	},
) {
	const scheduleId = workflowIds.jobSchedule(input.userId, input.jobId)
	const args: [JobRunInput] = [
		{ userId: input.userId, jobId: input.jobId, scheduledAt: null },
	]
	const options = {
		spec: jobScheduleSpec(input),
		action: {
			type: 'startWorkflow' as const,
			workflowType: 'JobRun',
			workflowId: scheduleId,
			taskQueue: taskQueues.runtime,
			args,
			typedSearchAttributes: [
				{ key: kodySearchAttributes.userId, value: input.userId },
				{ key: kodySearchAttributes.surface, value: 'job' },
			],
		},
		// One run per job at a time, and a missed fire runs once on recovery
		// (the JobManager alarm ran overdue jobs once, never per missed slot).
		// ponytail: 10-minute catch-up window; longer outages drop fires until the next one.
		policies: {
			overlap: input.wakeOnly ? ('BUFFER_ONE' as const) : ('SKIP' as const),
			catchupWindow: '10 minutes',
		},
		state: {
			paused: input.paused,
			...(input.schedule.type === 'once' ? { remainingActions: 1 } : {}),
		},
	} satisfies Omit<ScheduleOptions, 'scheduleId'>
	try {
		return await client.schedule.create({ scheduleId, ...options })
	} catch (error) {
		if (!(error instanceof ScheduleAlreadyRunning)) throw error
		const handle = client.schedule.getHandle(scheduleId)
		await handle.update((previous) => ({
			...previous,
			spec: options.spec,
			action: options.action,
			policies: { ...previous.policies, ...options.policies },
			state: {
				...previous.state,
				paused: input.paused,
				...(input.schedule.type === 'once'
					? { remainingActions: 1 }
					: { remainingActions: undefined }),
			},
		}))
		return handle
	}
}

export async function deleteSchedule(client: Client, scheduleId: string) {
	try {
		await client.schedule.getHandle(scheduleId).delete()
		return true
	} catch (error) {
		if (error instanceof ScheduleNotFoundError) return false
		throw error
	}
}

/** Reconcile the account's Aurora configuration with Temporal Schedules. */
export async function syncUserJobSchedules(
	client: Client,
	input: {
		userId: string
		wakeOnly?: boolean
		jobs: ReadonlyArray<
			Pick<
				JobRecord,
				| 'id'
				| 'schedule'
				| 'timezone'
				| 'nextRunAt'
				| 'expiresAt'
				| 'enabled'
				| 'killSwitchEnabled'
			>
		>
	},
) {
	const live = new Set<string>()
	for (const job of input.jobs) {
		live.add(workflowIds.jobSchedule(input.userId, job.id))
		const wakeAt = input.wakeOnly
			? new Date(
					Math.ceil(
						Math.max(Date.parse(job.nextRunAt), Date.now() + 1_000) / 1_000,
					) * 1_000,
				).toISOString()
			: job.nextRunAt
		await upsertJobSchedule(client, {
			...job,
			...(input.wakeOnly
				? {
						schedule: { type: 'once' as const, runAt: wakeAt },
						nextRunAt: wakeAt,
						expiresAt: null,
						wakeOnly: true,
					}
				: {}),
			userId: input.userId,
			jobId: job.id,
			paused:
				!job.enabled ||
				job.killSwitchEnabled ||
				(job.expiresAt !== null && Date.parse(job.expiresAt) <= Date.now()),
		})
	}
	// ponytail: list all schedules and filter by the exact account prefix; add indexed schedule attributes if fleet size makes this expensive.
	for await (const schedule of client.schedule.list()) {
		if (
			schedule.scheduleId.startsWith(`job:${input.userId}:`) &&
			!live.has(schedule.scheduleId)
		) {
			await deleteSchedule(client, schedule.scheduleId)
		}
	}
}
