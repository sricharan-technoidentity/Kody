import { expect, test, vi } from 'vitest'
import { ScheduleAlreadyRunning, type Client } from '@temporalio/client'
import {
	temporalJobScheduleNotePrefix,
	type TemporalScheduleUpsertRequest,
} from '@kody-internal/shared/temporal/job-schedules.ts'
import { upsertTemporalSchedule } from './schedules.ts'

function request(
	overrides: Partial<TemporalScheduleUpsertRequest> = {},
): TemporalScheduleUpsertRequest {
	return {
		scheduleId: 'kody-job-v1:abc',
		workflowId: 'kody-job-occ-v1:abc',
		taskQueue: 'kody-foundation',
		userHash: 'user-hash',
		jobId: 'job-1',
		desiredVersion: 7,
		enabled: true,
		backend: 'temporal',
		spec: {
			type: 'calendar',
			expression: '30 1 * * *',
			timezone: 'America/New_York',
			startAt: '2026-11-01T05:30:00.000Z',
			endAt: '2027-01-01T00:00:00.000Z',
		},
		...overrides,
	}
}

test('schedule upsert is active and a lost create response replays as an update', async () => {
	let existing = false
	let currentOptions: Record<string, unknown> | undefined
	const update = vi.fn(async (updater: (previous: never) => unknown) => {
		currentOptions = updater({} as never) as Record<string, unknown>
	})
	const create = vi.fn(async (options: Record<string, unknown>) => {
		if (existing)
			throw new ScheduleAlreadyRunning('already exists', 'schedule-1')
		existing = true
		currentOptions = options
	})
	const describe = vi.fn(async () => {
		const state = currentOptions?.['state'] as {
			paused: boolean
			note: string
		}
		return {
			action: currentOptions?.['action'],
			state,
			spec: {
				timezone: 'America/New_York',
				endAt: new Date('2027-01-01T00:00:00.000Z'),
			},
			info: {
				nextActionTimes: [new Date('2026-11-01T05:30:00.000Z')],
				numActionsTaken: 0,
				runningActions: [],
			},
		}
	})
	const client = {
		schedule: {
			create,
			getHandle: () => ({ update, describe }),
		},
	} as unknown as Client

	const desired = request()
	await expect(upsertTemporalSchedule(client, desired)).resolves.toMatchObject({
		exists: true,
		paused: false,
		note: `${temporalJobScheduleNotePrefix};version=7;enabled=1`,
		numActionsTaken: 0,
		runningActions: 0,
	})
	await expect(upsertTemporalSchedule(client, desired)).resolves.toMatchObject({
		exists: true,
		paused: false,
	})
	expect(create).toHaveBeenCalledTimes(2)
	expect(update).toHaveBeenCalledOnce()
	const action = currentOptions?.['action'] as Record<string, unknown>
	expect(action).toMatchObject({
		type: 'startWorkflow',
		workflowType: 'jobOccurrenceWorkflow',
		taskQueue: 'kody-foundation',
	})
	expect(JSON.stringify(action)).not.toContain('sourceRef')
})

test('interval schedules retain their original phase offset', async () => {
	let created: Record<string, unknown> | undefined
	const client = {
		schedule: {
			create: vi.fn(async (options: Record<string, unknown>) => {
				created = options
			}),
			getHandle: () => ({
				describe: vi.fn(async () => ({
					action: created?.['action'],
					state: { paused: false },
					spec: { timezone: 'UTC' },
					info: {
						nextActionTimes: [],
						numActionsTaken: 0,
						runningActions: [],
					},
				})),
			}),
		},
	} as unknown as Client

	await upsertTemporalSchedule(
		client,
		request({
			spec: {
				type: 'interval',
				every: '15m',
				offsetMs: 420_000,
				startAt: '2026-09-22T12:07:00.000Z',
			},
		}),
	)

	expect(created?.['spec']).toMatchObject({
		intervals: [{ every: '15m', offset: 420_000 }],
		startAt: new Date('2026-09-22T12:07:00.000Z'),
	})
})

test('migrated schedules start occurrence workflows and unpause only when enabled', async () => {
	let created: Record<string, unknown> | undefined
	const client = {
		schedule: {
			create: vi.fn(async (options: Record<string, unknown>) => {
				created = options
			}),
			getHandle: () => ({
				describe: vi.fn(async () => ({
					action: created?.['action'],
					state: {
						paused: false,
						note: 'kody-temporal-job;version=7;enabled=1',
					},
					spec: {
						timezone: 'America/New_York',
						endAt: new Date('2027-01-01T00:00:00.000Z'),
					},
					info: {
						nextActionTimes: [new Date('2026-11-01T05:30:00.000Z')],
						numActionsTaken: 2,
						runningActions: [{}],
					},
				})),
			}),
		},
	} as unknown as Client

	await expect(
		upsertTemporalSchedule(client, request({ backend: 'temporal' })),
	).resolves.toMatchObject({ paused: false, numActionsTaken: 2 })
	expect(created?.['state']).toMatchObject({ paused: false })
	expect(created?.['action']).toMatchObject({
		workflowType: 'jobOccurrenceWorkflow',
		workflowId: 'kody-job-occ-v1:abc',
		args: [
			expect.objectContaining({
				userHash: 'user-hash',
				jobId: 'job-1',
				trigger: 'scheduled',
			}),
		],
	})
})
