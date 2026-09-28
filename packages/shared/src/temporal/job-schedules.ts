import {
	computeNextRunAt,
	estimateScheduleMinIntervalMs,
	normalizeJobSchedule,
} from '../jobs/schedule.ts'
import { type JobRecord, type JobSchedule } from '../jobs/types.ts'

export const temporalJobOccurrenceWorkflowType = 'jobOccurrenceWorkflow'
export const temporalJobTaskQueue = 'kody-foundation'
export const temporalJobScheduleNotePrefix = 'kody-temporal-job'

export type JobScheduleBackend = 'temporal'

export type TemporalJobSchedulePayload = {
	scheduleId: string
	workflowId: string
	userHash: string
	jobId: string
	desiredVersion: number
	schedule: JobSchedule
	timezone: string
	nextRunAt: string
	expiresAt: string | null
	enabled: boolean
	backend: JobScheduleBackend
}

export type TemporalScheduleSpecInput =
	| {
			type: 'calendar'
			expression: string
			timezone: string
			startAt: string
			endAt?: string
	  }
	| {
			type: 'interval'
			every: string
			offsetMs: number
			startAt: string
			endAt?: string
	  }
	| {
			type: 'once'
			runAt: string
	  }

export type TemporalScheduleUpsertRequest = {
	scheduleId: string
	workflowId: string
	taskQueue: string
	userHash: string
	jobId: string
	desiredVersion: number
	enabled: boolean
	backend: JobScheduleBackend
	spec: TemporalScheduleSpecInput
}

export type TemporalScheduleDeleteRequest = {
	scheduleId: string
	userHash: string
	jobId: string
	desiredVersion: number
}

export type TemporalScheduleDescribeRequest = {
	scheduleId: string
	userHash: string
	jobId: string
	desiredVersion: number
}

export type TemporalScheduleDescription = {
	scheduleId: string
	exists: boolean
	paused?: boolean
	note?: string
	timezone?: string
	nextActionAt?: string
	endAt?: string
	numActionsTaken?: number
	runningActions?: number
	workflowType?: string
	workflowId?: string
}

export function toTemporalScheduleSpec(
	payload: TemporalJobSchedulePayload,
): TemporalScheduleSpecInput {
	const schedule = normalizeJobSchedule(payload.schedule)
	switch (schedule.type) {
		case 'cron':
			return {
				type: 'calendar',
				expression: schedule.expression,
				timezone: payload.timezone,
				startAt: payload.nextRunAt,
				...(payload.expiresAt ? { endAt: payload.expiresAt } : {}),
			}
		case 'interval': {
			const everyMs = estimateScheduleMinIntervalMs({ schedule })
			if (everyMs == null) {
				throw new Error('Interval schedule did not produce an interval.')
			}
			return {
				type: 'interval',
				every: schedule.every,
				offsetMs: new Date(payload.nextRunAt).valueOf() % everyMs,
				startAt: payload.nextRunAt,
				...(payload.expiresAt ? { endAt: payload.expiresAt } : {}),
			}
		}
		case 'once':
			return { type: 'once', runAt: schedule.runAt }
	}
}

export function toTemporalScheduleUpsertRequest(
	payload: TemporalJobSchedulePayload,
): TemporalScheduleUpsertRequest {
	return {
		scheduleId: payload.scheduleId,
		workflowId: payload.workflowId,
		taskQueue: temporalJobTaskQueue,
		userHash: payload.userHash,
		jobId: payload.jobId,
		desiredVersion: payload.desiredVersion,
		enabled: payload.enabled,
		backend: payload.backend,
		spec: toTemporalScheduleSpec(payload),
	}
}

export function expectedJobNextRunAt(
	job: Pick<JobRecord, 'schedule' | 'timezone' | 'nextRunAt'>,
) {
	return computeNextRunAt({
		schedule: job.schedule,
		timezone: job.timezone,
		from:
			job.schedule.type === 'once'
				? undefined
				: new Date(new Date(job.nextRunAt).valueOf() - 1),
	})
}

export function compareTemporalSchedule(input: {
	payload: TemporalJobSchedulePayload
	description: TemporalScheduleDescription
}) {
	const expectedSpec = toTemporalScheduleSpec(input.payload)
	const expectedTimezone =
		expectedSpec.type === 'calendar' ? expectedSpec.timezone : 'UTC'
	const differences: Array<string> = []
	const expectedPaused = !input.payload.enabled
	const expectedNote = `${temporalJobScheduleNotePrefix};version=${String(input.payload.desiredVersion)};enabled=${input.payload.enabled ? '1' : '0'}`
	if (!input.description.exists) differences.push('missing')
	const expectedWorkflowType = temporalJobOccurrenceWorkflowType
	if (
		input.description.exists &&
		input.description.workflowType !== undefined &&
		input.description.workflowType !== expectedWorkflowType
	) {
		differences.push('workflow_type')
	}
	if (
		input.description.exists &&
		input.description.workflowId !== undefined &&
		input.description.workflowId !== input.payload.workflowId
	) {
		differences.push('workflow_id')
	}
	if (input.description.exists && input.description.paused !== expectedPaused) {
		differences.push(expectedPaused ? 'not_paused' : 'unexpected_pause')
	}
	if (input.description.exists && input.description.note !== expectedNote) {
		differences.push('schedule_note')
	}
	if (
		input.description.exists &&
		input.description.timezone !== expectedTimezone
	) {
		differences.push('timezone')
	}
	if (
		input.description.exists &&
		input.description.nextActionAt !== input.payload.nextRunAt
	) {
		differences.push('next_occurrence')
	}
	const expectedEndAt =
		expectedSpec.type === 'once'
			? expectedSpec.runAt
			: (expectedSpec.endAt ?? undefined)
	if (input.description.exists && input.description.endAt !== expectedEndAt) {
		differences.push('expiration')
	}
	return differences
}
