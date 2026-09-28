import {
	finalizeClaimedJobRow,
	jobExecutionLeaseMs,
	mapJobRow,
	type JobRow,
} from '@kody-internal/shared/jobs/repo.ts'
import { computeNextRunAt } from '@kody-internal/shared/jobs/schedule.ts'
import {
	type FinalizeJobRequest,
	type JobOccurrenceClaimResult,
} from '@kody-internal/shared/temporal/contracts.ts'
import { type JobsWorkerEnv } from './env.ts'

const cloudflareBackendPredicate = `NOT EXISTS (
	SELECT 1 FROM job_schedule_bindings AS binding
	WHERE binding.job_id = jobs.id
		AND binding.user_id = jobs.user_id
		AND binding.backend = 'temporal'
)`

export async function listCloudflareDueJobs(input: {
	env: JobsWorkerEnv
	userId: string
	nowIso: string
}): Promise<Array<JobRow>> {
	const { results } = await input.env.JOBS_DB.prepare(
		`SELECT jobs.* FROM jobs
		WHERE jobs.user_id = ?
			AND jobs.enabled = 1
			AND jobs.kill_switch_enabled = 0
			AND (jobs.expires_at IS NULL OR jobs.expires_at > ?)
			AND jobs.next_run_at <= ?
			AND (jobs.claim_token IS NULL OR jobs.lease_expires_at IS NULL OR jobs.lease_expires_at <= ?)
			AND (jobs.last_completed_scheduled_for IS NULL OR jobs.last_completed_scheduled_for != COALESCE(jobs.retry_scheduled_for, jobs.next_run_at))
			AND ${cloudflareBackendPredicate}
		ORDER BY jobs.next_run_at ASC, jobs.name ASC
		LIMIT 25`,
	)
		.bind(input.userId, input.nowIso, input.nowIso, input.nowIso)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapJobRow)
}

export async function getNextCloudflareRunnableJob(input: {
	env: JobsWorkerEnv
	userId: string
	nowIso: string
}): Promise<JobRow | null> {
	const row = await input.env.JOBS_DB.prepare(
		`SELECT jobs.*,
			CASE
				WHEN jobs.claim_token IS NOT NULL AND jobs.lease_expires_at IS NOT NULL AND jobs.lease_expires_at > ? THEN jobs.lease_expires_at
				WHEN jobs.expires_at IS NOT NULL AND jobs.expires_at < jobs.next_run_at THEN jobs.expires_at
				ELSE jobs.next_run_at
			END AS scheduler_wake_at
		FROM jobs
		WHERE jobs.user_id = ?
			AND jobs.enabled = 1
			AND jobs.kill_switch_enabled = 0
			AND (jobs.expires_at IS NULL OR jobs.expires_at > ?)
			AND (jobs.last_completed_scheduled_for IS NULL OR jobs.last_completed_scheduled_for != COALESCE(jobs.retry_scheduled_for, jobs.next_run_at))
			AND ${cloudflareBackendPredicate}
		ORDER BY scheduler_wake_at ASC, jobs.name ASC
		LIMIT 1`,
	)
		.bind(input.nowIso, input.userId, input.nowIso)
		.first<Record<string, unknown>>()
	return row ? mapJobRow(row) : null
}

export async function claimCloudflareJob(input: {
	env: JobsWorkerEnv
	userId: string
	jobId: string
	nowMs: number
	claimToken: string
}): Promise<JobRow | null> {
	const now = new Date(input.nowMs)
	const nowIso = now.toISOString()
	const leaseExpiresAt = new Date(
		now.valueOf() + jobExecutionLeaseMs,
	).toISOString()
	const row = await input.env.JOBS_DB.prepare(
		`UPDATE jobs SET
			claim_token = ?, running_since = ?, lease_expires_at = ?,
			claimed_scheduled_for = COALESCE(retry_scheduled_for, next_run_at)
		WHERE id = ? AND user_id = ?
			AND enabled = 1 AND kill_switch_enabled = 0
			AND (expires_at IS NULL OR expires_at > ?)
			AND next_run_at <= ?
			AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
			AND (last_completed_scheduled_for IS NULL OR last_completed_scheduled_for != COALESCE(retry_scheduled_for, next_run_at))
			AND ${cloudflareBackendPredicate}
		RETURNING *`,
	)
		.bind(
			input.claimToken,
			nowIso,
			leaseExpiresAt,
			input.jobId,
			input.userId,
			nowIso,
			nowIso,
			nowIso,
		)
		.first<Record<string, unknown>>()
	return row ? mapJobRow(row) : null
}

export async function claimTemporalJobOccurrence(input: {
	env: JobsWorkerEnv
	userHash: string
	jobId: string
	scheduledFor: string
	claimRef: string
	now?: Date
}): Promise<JobOccurrenceClaimResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const scheduleToClaimLagMs = Math.max(
		0,
		now.valueOf() - Date.parse(input.scheduledFor),
	)
	const record = (
		outcome:
			| 'claimed'
			| 'idempotent_replay'
			| 'not_runnable'
			| 'already_completed'
			| 'claim_held',
	) => {
		console.info('temporal_job_occurrence_claim', {
			outcome,
			scheduleToClaimLagMs: Number.isFinite(scheduleToClaimLagMs)
				? scheduleToClaimLagMs
				: null,
		})
	}
	const leaseExpiresAt = new Date(
		now.valueOf() + jobExecutionLeaseMs,
	).toISOString()
	const existing = await getTemporalJobByIdentity(input)
	if (!existing) {
		record('not_runnable')
		return { claimed: false, reason: 'not-runnable' }
	}
	if (existing.last_completed_scheduled_for === input.scheduledFor) {
		record('already_completed')
		return { claimed: false, reason: 'already-completed' }
	}
	if (
		existing.claim_token === input.claimRef &&
		existing.claimed_scheduled_for === input.scheduledFor
	) {
		record('idempotent_replay')
		return { claimed: true, claimRef: input.claimRef }
	}
	const row = await input.env.JOBS_DB.prepare(
		`UPDATE jobs SET
			claim_token = ?, running_since = ?, lease_expires_at = ?,
			claimed_scheduled_for = ?
		WHERE id = ? AND user_id = ?
			AND enabled = 1 AND kill_switch_enabled = 0
			AND (expires_at IS NULL OR expires_at > ?)
			AND COALESCE(retry_scheduled_for, next_run_at) = ?
			AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
			AND (last_completed_scheduled_for IS NULL OR last_completed_scheduled_for != ?)
		RETURNING *`,
	)
		.bind(
			input.claimRef,
			nowIso,
			leaseExpiresAt,
			input.scheduledFor,
			existing.id,
			existing.user_id,
			nowIso,
			input.scheduledFor,
			nowIso,
			input.scheduledFor,
		)
		.first<Record<string, unknown>>()
	if (row) {
		record('claimed')
		return { claimed: true, claimRef: input.claimRef }
	}
	record('claim_held')
	return { claimed: false, reason: 'claim-held' }
}

async function getTemporalJobByIdentity(input: {
	env: JobsWorkerEnv
	userHash: string
	jobId: string
}): Promise<JobRow | null> {
	const row = await input.env.JOBS_DB.prepare(
		`SELECT jobs.* FROM jobs
		JOIN job_schedule_bindings AS binding
			ON binding.job_id = jobs.id AND binding.user_id = jobs.user_id
		WHERE binding.backend = 'temporal'
			AND binding.temporal_user_hash = ?
			AND binding.temporal_job_id = ?
		LIMIT 1`,
	)
		.bind(input.userHash, input.jobId)
		.first<Record<string, unknown>>()
	return row ? mapJobRow(row) : null
}

export async function getTemporalClaimedJob(input: {
	env: JobsWorkerEnv
	userHash: string
	jobId: string
	claimRef: string
}): Promise<JobRow | null> {
	const row = await getTemporalJobByIdentity(input)
	return row?.claim_token === input.claimRef ? row : null
}

export async function finalizeTemporalJobOccurrence(input: {
	env: JobsWorkerEnv
	userHash: string
	jobId: string
	claimRef: string
	scheduledFor: string
	status: FinalizeJobRequest['status']
	finishedAt: string
}) {
	const row = await getTemporalClaimedJob(input)
	if (!row || row.claimed_scheduled_for !== input.scheduledFor) return false
	const finishedAt = new Date(input.finishedAt)
	const terminalStatus =
		input.status === 'succeeded' ? ('success' as const) : ('error' as const)
	const updated = {
		...row.record,
		updatedAt: finishedAt.toISOString(),
		lastRunAt: finishedAt.toISOString(),
		lastRunStatus: terminalStatus,
		...(row.record.schedule.type === 'once'
			? { enabled: false }
			: {
					nextRunAt: computeNextRunAt({
						schedule: row.record.schedule,
						timezone: row.record.timezone,
						from: finishedAt,
					}),
				}),
	}
	return await finalizeClaimedJobRow({
		db: input.env.JOBS_DB,
		userId: row.user_id,
		job: updated,
		claimToken: input.claimRef,
		scheduledFor: input.scheduledFor,
	})
}
