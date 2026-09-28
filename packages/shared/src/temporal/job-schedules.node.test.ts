import { expect, test } from 'vitest'
import {
	compareTemporalSchedule,
	expectedJobNextRunAt,
	temporalJobScheduleNotePrefix,
	toTemporalScheduleSpec,
	type TemporalJobSchedulePayload,
} from './job-schedules.ts'

function payload(
	overrides: Partial<TemporalJobSchedulePayload> = {},
): TemporalJobSchedulePayload {
	return {
		scheduleId: 'kody-job-v1:abc',
		workflowId: 'kody-job-occ-v1:abc',
		userHash: 'user-hash',
		jobId: 'job-1',
		desiredVersion: 1,
		schedule: { type: 'cron', expression: '30 1 * * *' },
		timezone: 'America/New_York',
		nextRunAt: '2026-11-01T05:30:00.000Z',
		expiresAt: '2027-01-01T00:00:00.000Z',
		enabled: true,
		backend: 'temporal',
		...overrides,
	}
}

test('Temporal job specs preserve cron timezone, expiration, interval phase, and one-time timestamps', () => {
	expect(toTemporalScheduleSpec(payload())).toEqual({
		type: 'calendar',
		expression: '30 1 * * *',
		timezone: 'America/New_York',
		startAt: '2026-11-01T05:30:00.000Z',
		endAt: '2027-01-01T00:00:00.000Z',
	})
	expect(
		toTemporalScheduleSpec(
			payload({
				schedule: { type: 'interval', every: '15m' },
				timezone: 'UTC',
				nextRunAt: '2026-09-22T12:07:00.000Z',
				expiresAt: null,
			}),
		),
	).toEqual({
		type: 'interval',
		every: '15m',
		offsetMs: 420_000,
		startAt: '2026-09-22T12:07:00.000Z',
	})
	expect(
		toTemporalScheduleSpec(
			payload({
				schedule: { type: 'once', runAt: '2026-12-01T10:00:00Z' },
				nextRunAt: '2026-12-01T10:00:00.000Z',
			}),
		),
	).toEqual({ type: 'once', runAt: '2026-12-01T10:00:00.000Z' })
})

test('DST next occurrences match the existing scheduler contract', () => {
	expect(
		expectedJobNextRunAt({
			schedule: { type: 'cron', expression: '30 1 * * *' },
			timezone: 'America/New_York',
			nextRunAt: '2026-11-01T05:30:00.000Z',
		}),
	).toBe('2026-11-01T05:30:00.000Z')
	expect(
		expectedJobNextRunAt({
			schedule: { type: 'cron', expression: '30 2 * * *' },
			timezone: 'America/New_York',
			nextRunAt: '2026-03-09T06:30:00.000Z',
		}),
	).toBe('2026-03-09T06:30:00.000Z')
})

test('comparison reports manually introduced safety and timing drift', () => {
	const desired = payload()
	expect(
		compareTemporalSchedule({
			payload: desired,
			description: {
				scheduleId: desired.scheduleId,
				exists: true,
				paused: false,
				note: `${temporalJobScheduleNotePrefix};version=1;enabled=1`,
				timezone: desired.timezone,
				nextActionAt: desired.nextRunAt,
				endAt: desired.expiresAt ?? undefined,
				numActionsTaken: 0,
				runningActions: 0,
				workflowType: 'jobOccurrenceWorkflow',
				workflowId: desired.workflowId,
			},
		}),
	).toEqual([])
	expect(
		compareTemporalSchedule({
			payload: desired,
			description: {
				scheduleId: desired.scheduleId,
				exists: true,
				paused: true,
				note: 'manual change',
				timezone: 'UTC',
				nextActionAt: '2026-11-01T06:30:00.000Z',
				numActionsTaken: 1,
				runningActions: 1,
				workflowType: 'jobOccurrenceWorkflow',
				workflowId: desired.workflowId,
			},
		}),
	).toEqual([
		'unexpected_pause',
		'schedule_note',
		'timezone',
		'next_occurrence',
		'expiration',
	])
})
