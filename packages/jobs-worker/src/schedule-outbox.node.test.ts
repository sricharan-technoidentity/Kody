import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type JobRecord } from '@kody-internal/shared/jobs/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type JobsWorkerEnv } from './env.ts'
import { runTemporalScheduleReconcilerTick } from './schedule-reconciler.ts'
import {
	deleteJobWithScheduleOutbox,
	insertJobWithScheduleOutbox,
	updateJobWithScheduleOutbox,
} from './schedule-outbox.ts'

const signingKey = {
	id: 'current',
	secret: 'a-secure-test-secret-that-is-long-enough',
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-09-24T17:55:00.000Z'))
})

afterEach(() => {
	vi.useRealTimers()
})

function createJobsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: 'user-1',
		name: 'Daily report',
		sourceId: 'source-1',
		publishedCommit: 'abc123',
		storageId: 'job:job-1',
		schedule: { type: 'once', runAt: '2026-12-01T10:00:00.000Z' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-09-22T10:00:00.000Z',
		updatedAt: '2026-09-22T10:00:00.000Z',
		nextRunAt: '2026-12-01T10:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	}
}

function env(db: D1Database): JobsWorkerEnv {
	return {
		JOBS_DB: db,
		TEMPORAL_GATEWAY_URL: 'https://temporal-gateway.test',
		TEMPORAL_GATEWAY_SIGNING_KEYS: JSON.stringify([signingKey]),
	} as unknown as JobsWorkerEnv
}

function gatewayFetch() {
	return vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(request))
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		if (url.pathname === '/v1/schedules/delete') {
			return Response.json({ scheduleId: body['scheduleId'], deleted: true })
		}
		return Response.json({
			scheduleId: body['scheduleId'],
			exists: true,
			paused: body['enabled'] === false,
			note: `kody-temporal-job;version=${String(body['desiredVersion'])};enabled=${body['enabled'] === false ? '0' : '1'}`,
			timezone: 'UTC',
			nextActionAt: '2026-12-01T10:00:00.000Z',
			endAt: '2026-12-01T10:00:00.000Z',
			numActionsTaken: 0,
			runningActions: 0,
			workflowType: 'jobOccurrenceWorkflow',
			workflowId: body['workflowId'],
		})
	})
}

test('job create, update, and delete commit monotonic Temporal schedule operations in the same D1 batches', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	let binding = sqlite
		.prepare(
			`SELECT desired_version, applied_version, state FROM job_schedule_bindings`,
		)
		.get() as Record<string, unknown>
	expect(binding).toMatchObject({
		desired_version: 1,
		applied_version: 0,
		state: 'pending',
	})
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS n FROM job_schedule_outbox`).get(),
	).toEqual({ n: 1 })

	await expect(
		updateJobWithScheduleOutbox({
			db,
			userId: 'user-1',
			job: job({
				name: 'Updated report',
				updatedAt: '2026-09-22T11:00:00.000Z',
			}),
			callerContextJson: '{}',
		}),
	).resolves.toBe(true)
	binding = sqlite
		.prepare(`SELECT desired_version, state FROM job_schedule_bindings`)
		.get() as Record<string, unknown>
	expect(binding).toMatchObject({ desired_version: 2, state: 'pending' })

	await expect(
		deleteJobWithScheduleOutbox({ db, userId: 'user-1', jobId: 'job-1' }),
	).resolves.toBe(true)
	expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({
		n: 0,
	})
	expect(
		sqlite
			.prepare(
				`SELECT desired_version, state FROM job_schedule_bindings WHERE job_id = 'job-1'`,
			)
			.get(),
	).toEqual({ desired_version: 3, state: 'deleting' })
	expect(
		sqlite
			.prepare(
				`SELECT desired_operation, desired_version FROM job_schedule_outbox ORDER BY desired_version`,
			)
			.all(),
	).toEqual([
		{ desired_operation: 'upsert', desired_version: 1 },
		{ desired_operation: 'upsert', desired_version: 2 },
		{ desired_operation: 'delete', desired_version: 3 },
	])
})

test('outbox payloads replace raw user and package-job identifiers with hashes', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'person@example.com',
		job: job({
			id: 'package-job:pkg:archive%20sync%3A%20daily',
			userId: 'person@example.com',
		}),
		callerContextJson: '{}',
	})
	const row = sqlite
		.prepare(`SELECT payload_json FROM job_schedule_outbox`)
		.get() as { payload_json: string }
	const payload = JSON.parse(row.payload_json) as {
		jobId: string
		userHash: string
	}
	expect(payload.jobId).toMatch(/^[A-Za-z0-9_-]{32}$/)
	expect(payload.userHash).toMatch(/^[A-Za-z0-9_-]{32}$/)
	expect(row.payload_json).not.toContain('person@example.com')
	expect(row.payload_json).not.toContain('archive')
})

test('outbox replay skips stale versions, recovers a lost response, and never creates duplicate schedules', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	const successfulFetch = gatewayFetch()
	let responseLost = true
	const lossyFetch = vi.fn(
		async (request: RequestInfo | URL, init?: RequestInit) => {
			const response = await successfulFetch(request, init)
			if (responseLost) {
				responseLost = false
				throw new Error('response lost after Temporal committed')
			}
			return response
		},
	)
	const first = await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:00:00.000Z'),
		fetch: lossyFetch as typeof fetch,
	})
	expect(first).toMatchObject({ enabled: true, processed: 0, failed: 1 })
	expect(
		sqlite
			.prepare(`SELECT state, attempt_count FROM job_schedule_outbox`)
			.get(),
	).toEqual({ state: 'pending', attempt_count: 1 })

	const recovered = await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:20:00.000Z'),
		fetch: lossyFetch as typeof fetch,
	})
	expect(recovered).toMatchObject({ enabled: true, processed: 1, failed: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT applied_version, state, last_error FROM job_schedule_bindings`,
			)
			.get(),
	).toEqual({ applied_version: 1, state: 'in_sync', last_error: null })

	await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:25:00.000Z'),
		fetch: lossyFetch as typeof fetch,
	})
	const upserts = successfulFetch.mock.calls.filter(
		([request]) => new URL(String(request)).pathname === '/v1/schedules/upsert',
	)
	expect(upserts).toHaveLength(2)
})

test('reconciliation detects and repairs a manually paused or retimed schedule', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	let driftNextDescribe = false
	const requestFetch = vi.fn(
		async (request: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(request))
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>
			const drifted = url.pathname.endsWith('/describe') && driftNextDescribe
			if (drifted) driftNextDescribe = false
			return Response.json({
				scheduleId: body['scheduleId'],
				exists: true,
				paused: drifted,
				note: drifted
					? 'manually paused'
					: `kody-temporal-job;version=${String(body['desiredVersion'])};enabled=1`,
				timezone: 'UTC',
				nextActionAt: drifted
					? '2026-12-01T11:00:00.000Z'
					: '2026-12-01T10:00:00.000Z',
				endAt: '2026-12-01T10:00:00.000Z',
				numActionsTaken: 0,
				runningActions: 0,
				workflowType: 'jobOccurrenceWorkflow',
				workflowId: body['workflowId'],
			})
		},
	)
	await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:00:00.000Z'),
		fetch: requestFetch as typeof fetch,
	})
	driftNextDescribe = true
	const repaired = await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:05:00.000Z'),
		fetch: requestFetch as typeof fetch,
	})
	expect(repaired.repaired).toBe(1)
	expect(
		sqlite.prepare(`SELECT state, last_error FROM job_schedule_bindings`).get(),
	).toEqual({ state: 'in_sync', last_error: null })
	const calls = requestFetch.mock.calls.map(
		([request]) => new URL(String(request)).pathname,
	)
	expect(calls.slice(-2)).toEqual([
		'/v1/schedules/describe',
		'/v1/schedules/upsert',
	])
})

test('reconciler recovers abandoned processing leases', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	sqlite
		.prepare(
			`UPDATE job_schedule_outbox
			SET state = 'processing', updated_at = '2026-09-24T17:00:00.000Z'`,
		)
		.run()

	const result = await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:00:00.000Z'),
		fetch: gatewayFetch() as typeof fetch,
	})

	expect(result).toMatchObject({ processed: 1, failed: 0 })
	expect(sqlite.prepare(`SELECT state FROM job_schedule_outbox`).get()).toEqual(
		{ state: 'applied' },
	)
})

test('applied deletes remove retained user identifiers from schedule state', async () => {
	const { sqlite, db } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	await deleteJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		jobId: 'job-1',
	})

	await runTemporalScheduleReconcilerTick({
		env: env(db),
		now: new Date('2026-09-24T18:00:00.000Z'),
		fetch: gatewayFetch() as typeof fetch,
	})

	expect(
		sqlite.prepare(`SELECT COUNT(*) AS n FROM job_schedule_bindings`).get(),
	).toEqual({ n: 0 })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS n FROM job_schedule_outbox`).get(),
	).toEqual({ n: 0 })
})
