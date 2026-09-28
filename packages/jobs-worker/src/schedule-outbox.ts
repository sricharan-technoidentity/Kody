import {
	prepareDeleteJobRow,
	prepareInsertJobRow,
	prepareUpdateJobRow,
} from '@kody-internal/shared/jobs/repo.ts'
import { type JobRecord } from '@kody-internal/shared/jobs/types.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	buildJobScheduleId,
	buildJobOccurrenceWorkflowBaseId,
	buildTemporalJobHash,
	buildTemporalUserHash,
} from '@kody-internal/shared/temporal/identifiers.ts'
import { type TemporalJobSchedulePayload } from '@kody-internal/shared/temporal/job-schedules.ts'

export type StoredJobSchedulePayload = Omit<
	TemporalJobSchedulePayload,
	'desiredVersion'
>

function prepareBindingUpsert(input: {
	db: D1Database
	jobId: string
	userId: string
	scheduleId: string
	userHash: string
	temporalJobId: string
	now: string
}) {
	return input.db
		.prepare(
			`INSERT INTO job_schedule_bindings (
				job_id, user_id, backend, temporal_schedule_id, desired_version,
				applied_version, state, updated_at, temporal_user_hash,
				temporal_job_id
			)
			SELECT ?, ?, 'temporal', ?, 1, 0, 'pending', ?, ?, ?
			WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND user_id = ?)
			ON CONFLICT(user_id, job_id) DO UPDATE SET
				temporal_schedule_id = excluded.temporal_schedule_id,
				temporal_user_hash = excluded.temporal_user_hash,
				temporal_job_id = excluded.temporal_job_id,
				desired_version = job_schedule_bindings.desired_version + 1,
				state = 'pending',
				last_error = NULL,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.jobId,
			input.userId,
			input.scheduleId,
			input.now,
			input.userHash,
			input.temporalJobId,
			input.jobId,
			input.userId,
		)
}

function prepareBindingDelete(input: {
	db: D1Database
	jobId: string
	userId: string
	now: string
}) {
	return input.db
		.prepare(
			`UPDATE job_schedule_bindings SET
				desired_version = desired_version + 1,
				state = 'deleting',
				last_error = NULL,
				updated_at = ?
			WHERE job_id = ? AND user_id = ?
				AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND user_id = ?)`,
		)
		.bind(input.now, input.jobId, input.userId, input.jobId, input.userId)
}

function prepareOutboxInsert(input: {
	db: D1Database
	operationId: string
	jobId: string
	userId: string
	operation: 'upsert' | 'delete'
	payloadJson: string
	payloadHash: string
	now: string
}) {
	return input.db
		.prepare(
			`INSERT INTO job_schedule_outbox (
				operation_id, job_id, user_id, desired_operation, desired_version,
				payload_json, payload_hash, state, next_attempt_at, created_at,
				updated_at
			)
			SELECT ?, ?, ?, ?, desired_version, ?, ?, 'pending', ?, ?, ?
			FROM job_schedule_bindings
			WHERE job_id = ? AND user_id = ?
			ON CONFLICT(user_id, job_id, desired_version) DO NOTHING`,
		)
		.bind(
			input.operationId,
			input.jobId,
			input.userId,
			input.operation,
			input.payloadJson,
			input.payloadHash,
			input.now,
			input.now,
			input.now,
			input.jobId,
			input.userId,
		)
}

export async function buildStoredSchedulePayload(input: {
	userId: string
	job: JobRecord
}): Promise<StoredJobSchedulePayload> {
	const userHash = await buildTemporalUserHash(input.userId)
	const jobId = await buildTemporalJobHash(input.userId, input.job.id)
	return {
		scheduleId: await buildJobScheduleId(input.userId, input.job.id),
		workflowId: await buildJobOccurrenceWorkflowBaseId(
			input.userId,
			input.job.id,
		),
		userHash,
		jobId,
		schedule: input.job.schedule,
		timezone: input.job.timezone,
		nextRunAt: input.job.nextRunAt,
		expiresAt: input.job.expiresAt,
		enabled: input.job.enabled && !input.job.killSwitchEnabled,
		backend: 'temporal',
	}
}

async function outboxPayload(value: unknown) {
	const payloadJson = JSON.stringify(value)
	return { payloadJson, payloadHash: await sha256Hex(payloadJson) }
}

export async function enqueueJobScheduleOutbox(input: {
	db: D1Database
	userId: string
	job: JobRecord
}) {
	const payload = await buildStoredSchedulePayload({
		...input,
	})
	const serialized = await outboxPayload(payload)
	const now = new Date().toISOString()
	await input.db.batch([
		prepareBindingUpsert({
			db: input.db,
			jobId: input.job.id,
			userId: input.userId,
			scheduleId: payload.scheduleId,
			userHash: payload.userHash,
			temporalJobId: payload.jobId,
			now,
		}),
		prepareOutboxInsert({
			db: input.db,
			operationId: crypto.randomUUID(),
			jobId: input.job.id,
			userId: input.userId,
			operation: 'upsert',
			...serialized,
			now,
		}),
	])
}

export async function insertJobWithScheduleOutbox(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const payload = await buildStoredSchedulePayload({
		...input,
	})
	const serialized = await outboxPayload(payload)
	const now = new Date().toISOString()
	await input.db.batch([
		prepareInsertJobRow(input),
		prepareBindingUpsert({
			db: input.db,
			jobId: input.job.id,
			userId: input.userId,
			scheduleId: payload.scheduleId,
			userHash: payload.userHash,
			temporalJobId: payload.jobId,
			now,
		}),
		prepareOutboxInsert({
			db: input.db,
			operationId: crypto.randomUUID(),
			jobId: input.job.id,
			userId: input.userId,
			operation: 'upsert',
			...serialized,
			now,
		}),
	])
}

export async function updateJobWithScheduleOutbox(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const payload = await buildStoredSchedulePayload({
		...input,
	})
	const serialized = await outboxPayload(payload)
	const now = new Date().toISOString()
	const [updated] = await input.db.batch([
		prepareUpdateJobRow(input),
		prepareBindingUpsert({
			db: input.db,
			jobId: input.job.id,
			userId: input.userId,
			scheduleId: payload.scheduleId,
			userHash: payload.userHash,
			temporalJobId: payload.jobId,
			now,
		}),
		prepareOutboxInsert({
			db: input.db,
			operationId: crypto.randomUUID(),
			jobId: input.job.id,
			userId: input.userId,
			operation: 'upsert',
			...serialized,
			now,
		}),
	])
	return (updated?.meta.changes ?? 0) > 0
}

export async function deleteJobWithScheduleOutbox(input: {
	db: D1Database
	userId: string
	jobId: string
}) {
	const binding = await input.db
		.prepare(
			`SELECT temporal_schedule_id FROM job_schedule_bindings
			WHERE job_id = ? AND user_id = ?`,
		)
		.bind(input.jobId, input.userId)
		.first<{ temporal_schedule_id: string }>()
	const scheduleId =
		binding?.temporal_schedule_id ??
		(await buildJobScheduleId(input.userId, input.jobId))
	const payload = {
		scheduleId,
		userHash: await buildTemporalUserHash(input.userId),
		jobId: await buildTemporalJobHash(input.userId, input.jobId),
	}
	const serialized = await outboxPayload(payload)
	const now = new Date().toISOString()
	const results = await input.db.batch([
		prepareBindingDelete({
			db: input.db,
			jobId: input.jobId,
			userId: input.userId,
			now,
		}),
		prepareOutboxInsert({
			db: input.db,
			operationId: crypto.randomUUID(),
			jobId: input.jobId,
			userId: input.userId,
			operation: 'delete',
			...serialized,
			now,
		}),
		prepareDeleteJobRow(input.db, input.userId, input.jobId),
	])
	return (results[2]?.meta.changes ?? 0) > 0
}

export async function purgeUserJobsWithScheduleOutbox(input: {
	db: D1Database
	userId: string
}) {
	const { results: jobs = [] } = await input.db
		.prepare(`SELECT id FROM jobs WHERE user_id = ? ORDER BY id`)
		.bind(input.userId)
		.all<{ id: string }>()
	for (const job of jobs) {
		await deleteJobWithScheduleOutbox({
			db: input.db,
			userId: input.userId,
			jobId: job.id,
		})
	}
	await input.db
		.prepare(`DELETE FROM archived_job_artifacts WHERE user_id = ?`)
		.bind(input.userId)
		.run()
}
