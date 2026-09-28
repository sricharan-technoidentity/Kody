import {
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
	ScheduleOverlapPolicy,
	type Client,
	type ScheduleOptions,
	type ScheduleOptionsStartWorkflowAction,
	type ScheduleUpdateOptions,
} from '@temporalio/client'
import { type Workflow } from '@temporalio/common'
import {
	temporalJobScheduleNotePrefix,
	temporalJobOccurrenceWorkflowType,
	type TemporalScheduleDescription,
	type TemporalScheduleSpecInput,
	type TemporalScheduleUpsertRequest,
} from '@kody-internal/shared/temporal/job-schedules.ts'

function toSdkSpec(spec: TemporalScheduleSpecInput): ScheduleOptions['spec'] {
	switch (spec.type) {
		case 'calendar':
			return {
				cronExpressions: [spec.expression],
				timezone: spec.timezone,
				startAt: new Date(spec.startAt),
				...(spec.endAt ? { endAt: new Date(spec.endAt) } : {}),
			}
		case 'interval':
			return {
				intervals: [{ every: spec.every, offset: spec.offsetMs }],
				startAt: new Date(spec.startAt),
				...(spec.endAt ? { endAt: new Date(spec.endAt) } : {}),
			}
		case 'once': {
			const runAt = new Date(spec.runAt)
			return {
				cronExpressions: [
					`${String(runAt.getUTCSeconds())} ${String(runAt.getUTCMinutes())} ${String(runAt.getUTCHours())} ${String(runAt.getUTCDate())} ${String(runAt.getUTCMonth() + 1)} * ${String(runAt.getUTCFullYear())}`,
				],
				timezone: 'UTC',
				startAt: runAt,
				endAt: runAt,
			}
		}
	}
}

function scheduleOptions(
	input: TemporalScheduleUpsertRequest,
): ScheduleUpdateOptions<ScheduleOptionsStartWorkflowAction<Workflow>> {
	return {
		spec: toSdkSpec(input.spec),
		action: {
			type: 'startWorkflow',
			workflowType: temporalJobOccurrenceWorkflowType,
			workflowId: input.workflowId,
			taskQueue: input.taskQueue,
			args: [
				{
					workflowId: input.workflowId,
					userHash: input.userHash,
					jobId: input.jobId,
					runRef: input.workflowId,
					scheduledFor:
						input.spec.type === 'once' ? input.spec.runAt : input.spec.startAt,
					trigger: 'scheduled',
				},
			],
		},
		policies: {
			overlap: ScheduleOverlapPolicy.SKIP,
			catchupWindow: '1 minute',
			pauseOnFailure: true,
		},
		state: {
			paused: !input.enabled,
			note: `${temporalJobScheduleNotePrefix};version=${String(input.desiredVersion)};enabled=${input.enabled ? '1' : '0'}`,
		},
	}
}

export async function describeTemporalSchedule(
	client: Client,
	scheduleId: string,
): Promise<TemporalScheduleDescription> {
	try {
		const description = await client.schedule.getHandle(scheduleId).describe()
		return {
			scheduleId,
			exists: true,
			paused: description.state.paused,
			...(description.state.note ? { note: description.state.note } : {}),
			timezone: description.spec.timezone ?? 'UTC',
			...(description.info.nextActionTimes[0]
				? { nextActionAt: description.info.nextActionTimes[0].toISOString() }
				: {}),
			...(description.spec.endAt
				? { endAt: description.spec.endAt.toISOString() }
				: {}),
			numActionsTaken: description.info.numActionsTaken,
			runningActions: description.info.runningActions.length,
			workflowType: description.action.workflowType,
			...(description.action.workflowId
				? { workflowId: description.action.workflowId }
				: {}),
		}
	} catch (error) {
		if (error instanceof ScheduleNotFoundError) {
			return { scheduleId, exists: false }
		}
		throw error
	}
}

export async function upsertTemporalSchedule(
	client: Client,
	input: TemporalScheduleUpsertRequest,
) {
	const desired = scheduleOptions(input)
	try {
		await client.schedule.create({ scheduleId: input.scheduleId, ...desired })
	} catch (error) {
		if (!(error instanceof ScheduleAlreadyRunning)) throw error
		await client.schedule.getHandle(input.scheduleId).update(() => desired)
	}
	return await describeTemporalSchedule(client, input.scheduleId)
}

export async function deleteTemporalSchedule(
	client: Client,
	scheduleId: string,
) {
	try {
		await client.schedule.getHandle(scheduleId).delete()
	} catch (error) {
		if (!(error instanceof ScheduleNotFoundError)) throw error
	}
	return { scheduleId, deleted: true as const }
}
