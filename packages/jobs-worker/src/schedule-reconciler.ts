import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	compareTemporalSchedule,
	toTemporalScheduleUpsertRequest,
	type TemporalScheduleDescription,
	type TemporalJobSchedulePayload,
} from '@kody-internal/shared/temporal/job-schedules.ts'
import { type JobsWorkerEnv } from './env.ts'
import { jobsStore } from './store.ts'
import {
	deleteTemporalSchedule,
	describeTemporalSchedule,
	upsertTemporalSchedule,
} from './temporal-schedule-client.ts'
import {
	enqueueJobScheduleOutbox,
	type StoredJobSchedulePayload,
} from './schedule-outbox.ts'

const batchSize = 25
const maxErrorLength = 1_000
const processingLeaseMs = 15 * 60 * 1_000

type OutboxRow = {
	operation_id: string
	job_id: string
	user_id: string
	desired_operation: 'upsert' | 'delete'
	desired_version: number
	payload_json: string
	payload_hash: string
	binding_version: number
	attempt_count: number
}

type DriftRow = {
	job_id: string
	user_id: string
	temporal_schedule_id: string
	desired_version: number
	schedule_json: string
	timezone: string
	next_run_at: string
	expires_at: string | null
	enabled: number
	kill_switch_enabled: number
	backend: 'temporal'
}

function enabled(env: JobsWorkerEnv) {
	return Boolean(
		env.TEMPORAL_GATEWAY_URL?.trim() &&
		env.TEMPORAL_GATEWAY_SIGNING_KEYS?.trim(),
	)
}

function errorMessage(error: unknown) {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		maxErrorLength,
	)
}

function retryAt(attemptCount: number, now: Date) {
	const seconds = Math.min(5 * 2 ** Math.min(attemptCount, 8), 15 * 60)
	return new Date(now.valueOf() + seconds * 1_000).toISOString()
}

async function markOutboxApplied(input: {
	db: D1Database
	operationId: string
	nowIso: string
}) {
	await input.db
		.prepare(
			`UPDATE job_schedule_outbox SET
				state = 'applied', applied_at = ?, updated_at = ?, last_error = NULL
			WHERE operation_id = ?`,
		)
		.bind(input.nowIso, input.nowIso, input.operationId)
		.run()
}

async function markOutboxRetry(input: {
	db: D1Database
	operationId: string
	attemptCount: number
	error: unknown
	now: Date
}) {
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`UPDATE job_schedule_outbox SET
				state = 'pending', attempt_count = attempt_count + 1,
				next_attempt_at = ?, last_error = ?, updated_at = ?
			WHERE operation_id = ?`,
		)
		.bind(
			retryAt(input.attemptCount, input.now),
			errorMessage(input.error),
			nowIso,
			input.operationId,
		)
		.run()
}

async function updateBinding(input: {
	db: D1Database
	jobId: string
	userId: string
	desiredVersion: number
	description: TemporalScheduleDescription
	differences: ReadonlyArray<string>
	nowIso: string
}) {
	const state = input.differences.length === 0 ? 'in_sync' : 'drifted'
	await input.db
		.prepare(
			`UPDATE job_schedule_bindings SET
				applied_version = ?, state = ?, last_error = ?,
				expected_next_run_at = COALESCE(expected_next_run_at, ?),
				observed_next_run_at = ?, updated_at = ?
			WHERE job_id = ? AND user_id = ? AND desired_version = ?`,
		)
		.bind(
			input.desiredVersion,
			state,
			input.differences.length > 0
				? `drift:${input.differences.join(',')}`
				: null,
			input.description.nextActionAt ?? null,
			input.description.nextActionAt ?? null,
			input.nowIso,
			input.jobId,
			input.userId,
			input.desiredVersion,
		)
		.run()
}

async function processOutboxRow(input: {
	env: JobsWorkerEnv
	row: OutboxRow
	now: Date
	fetch?: typeof fetch
}) {
	const nowIso = input.now.toISOString()
	if (input.row.desired_version !== input.row.binding_version) {
		await markOutboxApplied({
			db: input.env.JOBS_DB,
			operationId: input.row.operation_id,
			nowIso,
		})
		return 'stale' as const
	}
	const claimed = await input.env.JOBS_DB.prepare(
		`UPDATE job_schedule_outbox SET state = 'processing', updated_at = ?
		WHERE operation_id = ? AND state = 'pending'`,
	)
		.bind(nowIso, input.row.operation_id)
		.run()
	if ((claimed.meta.changes ?? 0) === 0) return 'skipped' as const
	try {
		const actualHash = await sha256Hex(input.row.payload_json)
		if (actualHash !== input.row.payload_hash) {
			throw new Error('Schedule outbox payload hash mismatch.')
		}
		if (input.row.desired_operation === 'delete') {
			const stored = JSON.parse(input.row.payload_json) as {
				scheduleId: string
				userHash: string
				jobId: string
			}
			await deleteTemporalSchedule({
				env: input.env,
				request: { ...stored, desiredVersion: input.row.desired_version },
				fetch: input.fetch,
			})
			await input.env.JOBS_DB.batch([
				input.env.JOBS_DB.prepare(
					`DELETE FROM job_schedule_bindings
						WHERE job_id = ? AND user_id = ? AND desired_version = ?`,
				).bind(input.row.job_id, input.row.user_id, input.row.desired_version),
				input.env.JOBS_DB.prepare(
					`DELETE FROM job_schedule_outbox
						WHERE job_id = ? AND user_id = ? AND desired_version <= ?`,
				).bind(input.row.job_id, input.row.user_id, input.row.desired_version),
			])
			return 'applied' as const
		} else {
			const parsed = JSON.parse(
				input.row.payload_json,
			) as StoredJobSchedulePayload
			const stored = {
				...parsed,
				backend: 'temporal' as const,
			}
			const payload: TemporalJobSchedulePayload = {
				...stored,
				desiredVersion: input.row.desired_version,
			}
			const description = await upsertTemporalSchedule({
				env: input.env,
				request: toTemporalScheduleUpsertRequest(payload),
				fetch: input.fetch,
			})
			const differences = compareTemporalSchedule({ payload, description })
			await input.env.JOBS_DB.prepare(
				`UPDATE job_schedule_bindings SET expected_next_run_at = ?
				WHERE job_id = ? AND user_id = ? AND desired_version = ?`,
			)
				.bind(
					payload.nextRunAt,
					input.row.job_id,
					input.row.user_id,
					input.row.desired_version,
				)
				.run()
			await updateBinding({
				db: input.env.JOBS_DB,
				jobId: input.row.job_id,
				userId: input.row.user_id,
				desiredVersion: input.row.desired_version,
				description,
				differences,
				nowIso,
			})
		}
		await markOutboxApplied({
			db: input.env.JOBS_DB,
			operationId: input.row.operation_id,
			nowIso,
		})
		return 'applied' as const
	} catch (error) {
		await markOutboxRetry({
			db: input.env.JOBS_DB,
			operationId: input.row.operation_id,
			attemptCount: input.row.attempt_count,
			error,
			now: input.now,
		})
		await input.env.JOBS_DB.prepare(
			`UPDATE job_schedule_bindings SET state = 'error', last_error = ?, updated_at = ?
			WHERE job_id = ? AND user_id = ? AND desired_version = ?`,
		)
			.bind(
				errorMessage(error),
				nowIso,
				input.row.job_id,
				input.row.user_id,
				input.row.desired_version,
			)
			.run()
		return 'failed' as const
	}
}

async function repairDriftRow(input: {
	env: JobsWorkerEnv
	row: DriftRow
	nowIso: string
	fetch?: typeof fetch
}) {
	const pendingPayload = await input.env.JOBS_DB.prepare(
		`SELECT payload_json FROM job_schedule_outbox
		WHERE job_id = ? AND user_id = ? AND desired_version = ?
		ORDER BY created_at DESC LIMIT 1`,
	)
		.bind(input.row.job_id, input.row.user_id, input.row.desired_version)
		.first<{ payload_json: string }>()
	if (!pendingPayload) return false
	const parsed = JSON.parse(
		pendingPayload.payload_json,
	) as StoredJobSchedulePayload
	const stored = {
		...parsed,
		backend: 'temporal' as const,
	}
	const payload: TemporalJobSchedulePayload = {
		scheduleId: input.row.temporal_schedule_id,
		workflowId: stored.workflowId,
		userHash: stored.userHash,
		jobId: stored.jobId,
		desiredVersion: input.row.desired_version,
		schedule: JSON.parse(
			input.row.schedule_json,
		) as TemporalJobSchedulePayload['schedule'],
		timezone: input.row.timezone,
		nextRunAt: input.row.next_run_at,
		expiresAt: input.row.expires_at,
		enabled: input.row.enabled === 1 && input.row.kill_switch_enabled !== 1,
		backend: 'temporal',
	}
	let description = await describeTemporalSchedule({
		env: input.env,
		request: {
			scheduleId: payload.scheduleId,
			userHash: payload.userHash,
			jobId: payload.jobId,
			desiredVersion: payload.desiredVersion,
		},
		fetch: input.fetch,
	})
	let differences = compareTemporalSchedule({ payload, description })
	const hadDrift = differences.length > 0
	if (differences.length > 0) {
		description = await upsertTemporalSchedule({
			env: input.env,
			request: toTemporalScheduleUpsertRequest(payload),
			fetch: input.fetch,
		})
		differences = compareTemporalSchedule({ payload, description })
	}
	await updateBinding({
		db: input.env.JOBS_DB,
		jobId: input.row.job_id,
		userId: input.row.user_id,
		desiredVersion: payload.desiredVersion,
		description,
		differences,
		nowIso: input.nowIso,
	})
	return hadDrift && differences.length === 0
}

export async function runTemporalScheduleReconcilerTick(input: {
	env: JobsWorkerEnv
	now?: Date
	fetch?: typeof fetch
}) {
	if (!enabled(input.env)) {
		return { enabled: false, processed: 0, failed: 0, repaired: 0 }
	}
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const staleProcessingBefore = new Date(
		now.valueOf() - processingLeaseMs,
	).toISOString()
	await input.env.JOBS_DB.prepare(
		`UPDATE job_schedule_outbox SET
			state = 'pending', next_attempt_at = ?,
			last_error = 'Recovered abandoned processing lease.', updated_at = ?
		WHERE state = 'processing' AND updated_at <= ?`,
	)
		.bind(nowIso, nowIso, staleProcessingBefore)
		.run()
	const { results: missingBindings = [] } = await input.env.JOBS_DB.prepare(
		`SELECT jobs.id, jobs.user_id
		FROM jobs
		LEFT JOIN job_schedule_bindings AS bindings
			ON bindings.job_id = jobs.id AND bindings.user_id = jobs.user_id
		WHERE bindings.job_id IS NULL
		ORDER BY jobs.id
		LIMIT ?`,
	)
		.bind(batchSize)
		.all<{ id: string; user_id: string }>()
	for (const missing of missingBindings) {
		const row = await jobsStore(input.env).getJobById({
			userId: missing.user_id,
			jobId: missing.id,
		})
		if (!row) continue
		await enqueueJobScheduleOutbox({
			db: input.env.JOBS_DB,
			userId: missing.user_id,
			job: row.record,
		})
	}
	const { results: outboxRows = [] } = await input.env.JOBS_DB.prepare(
		`SELECT outbox.*, bindings.desired_version AS binding_version
		FROM job_schedule_outbox AS outbox
		JOIN job_schedule_bindings AS bindings
			ON bindings.job_id = outbox.job_id AND bindings.user_id = outbox.user_id
		WHERE outbox.state = 'pending' AND outbox.next_attempt_at <= ?
		ORDER BY outbox.created_at ASC
		LIMIT ?`,
	)
		.bind(nowIso, batchSize)
		.all<OutboxRow>()
	let processed = 0
	let failed = 0
	for (const row of outboxRows) {
		const outcome = await processOutboxRow({
			env: input.env,
			row,
			now,
			fetch: input.fetch,
		})
		if (outcome === 'applied') processed += 1
		if (outcome === 'failed') failed += 1
	}

	const { results: driftRows = [] } = await input.env.JOBS_DB.prepare(
		`SELECT bindings.job_id, bindings.user_id, bindings.temporal_schedule_id,
			bindings.desired_version, bindings.backend, jobs.schedule_json, jobs.timezone,
			jobs.next_run_at, jobs.expires_at, jobs.enabled, jobs.kill_switch_enabled
		FROM job_schedule_bindings AS bindings
		JOIN jobs ON jobs.id = bindings.job_id AND jobs.user_id = bindings.user_id
		WHERE bindings.state IN ('in_sync', 'drifted', 'error')
			AND NOT EXISTS (
				SELECT 1 FROM job_schedule_outbox AS pending
				WHERE pending.job_id = bindings.job_id
					AND pending.user_id = bindings.user_id
					AND pending.desired_version = bindings.desired_version
					AND pending.state IN ('pending', 'processing')
			)
		ORDER BY bindings.updated_at ASC
		LIMIT ?`,
	)
		.bind(batchSize)
		.all<DriftRow>()
	let repaired = 0
	for (const row of driftRows) {
		try {
			if (
				await repairDriftRow({
					env: input.env,
					row,
					nowIso,
					fetch: input.fetch,
				})
			) {
				repaired += 1
			}
		} catch (error) {
			failed += 1
			await input.env.JOBS_DB.prepare(
				`UPDATE job_schedule_bindings SET state = 'error', last_error = ?, updated_at = ?
				WHERE job_id = ? AND user_id = ? AND desired_version = ?`,
			)
				.bind(
					errorMessage(error),
					nowIso,
					row.job_id,
					row.user_id,
					row.desired_version,
				)
				.run()
		}
	}
	return { enabled: true, processed, failed, repaired }
}
