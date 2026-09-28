import { runD1WithRetry } from '@kody-internal/shared/d1-retry.ts'

/**
 * Liveness and JOBS_DB checks for the jobs worker. The public status page
 * probes these over a service binding (no public jobs hostname). JOBS_DB
 * rides on the same Jobs component — there is no separate storage card.
 */

const componentCheckTimeoutMs = 5_000
const d1CheckRetryOptions = {
	maxAttempts: 3,
	attemptTimeoutMs: 900,
} as const
const noStoreHeaders = { 'Cache-Control': 'no-store' } as const

type JobsHealthComponentId = 'jobs_db'

type JobsHealthComponentResult = {
	id: JobsHealthComponentId
	ok: boolean
	latencyMs: number
	error?: 'timeout' | 'unavailable' | 'error'
}

export type JobsHealthComponentsReport = {
	ok: boolean
	commit: string | null
	checkedAt: string
	components: Array<JobsHealthComponentResult>
	temporalScheduleSync?: TemporalScheduleDiagnostics
}

type TemporalScheduleDiagnostics = {
	bindings: number
	pendingOperations: number
	drifted: number
	errors: number
	actionsDetected: number
	temporalBackends: number
	activeTemporalClaims: number
}

type JobsHealthEnv = {
	JOBS_DB?: D1Database
	APP_COMMIT_SHA?: string
}

async function collectTemporalScheduleDiagnostics(
	db: D1Database,
): Promise<TemporalScheduleDiagnostics> {
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM job_schedule_bindings) AS bindings,
				(SELECT COUNT(*) FROM job_schedule_outbox WHERE state != 'applied') AS pending_operations,
				(SELECT COUNT(*) FROM job_schedule_bindings WHERE state = 'drifted') AS drifted,
				(SELECT COUNT(*) FROM job_schedule_bindings WHERE state = 'error') AS errors,
				(SELECT COUNT(*) FROM job_schedule_bindings WHERE last_error LIKE '%actions_taken%') AS actions_detected,
				(SELECT COUNT(*) FROM job_schedule_bindings WHERE backend = 'temporal') AS temporal_backends,
				(SELECT COUNT(*) FROM jobs
					JOIN job_schedule_bindings AS binding
						ON binding.job_id = jobs.id AND binding.user_id = jobs.user_id
					WHERE binding.backend = 'temporal' AND jobs.claim_token IS NOT NULL
						AND jobs.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_temporal_claims`,
		)
		.first<{
			bindings: number
			pending_operations: number
			drifted: number
			errors: number
			actions_detected: number
			temporal_backends: number
			active_temporal_claims: number
		}>()
	return {
		bindings: Number(row?.bindings ?? 0),
		pendingOperations: Number(row?.pending_operations ?? 0),
		drifted: Number(row?.drifted ?? 0),
		errors: Number(row?.errors ?? 0),
		actionsDetected: Number(row?.actions_detected ?? 0),
		temporalBackends: Number(row?.temporal_backends ?? 0),
		activeTemporalClaims: Number(row?.active_temporal_claims ?? 0),
	}
}

async function checkJobsDb(
	db: D1Database | undefined,
): Promise<JobsHealthComponentResult> {
	const startedAt = Date.now()
	if (!db) {
		return { id: 'jobs_db', ok: false, latencyMs: 0, error: 'unavailable' }
	}
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'timeout'>((resolve) => {
		timeoutHandle = setTimeout(
			() => resolve('timeout'),
			componentCheckTimeoutMs,
		)
	})
	try {
		const outcome = await Promise.race([
			runD1WithRetry(
				() => db.prepare('SELECT 1').first(),
				d1CheckRetryOptions,
			).then(() => 'ok' as const),
			timeout,
		])
		const latencyMs = Date.now() - startedAt
		if (outcome === 'timeout') {
			console.warn(
				'jobs-health-component-timeout',
				JSON.stringify({ id: 'jobs_db' }),
			)
			return { id: 'jobs_db', ok: false, latencyMs, error: 'timeout' }
		}
		return { id: 'jobs_db', ok: true, latencyMs }
	} catch (error) {
		const latencyMs = Date.now() - startedAt
		console.warn(
			'jobs-health-component-failed',
			JSON.stringify({
				id: 'jobs_db',
				message: error instanceof Error ? error.message : String(error),
			}),
		)
		return { id: 'jobs_db', ok: false, latencyMs, error: 'error' }
	} finally {
		clearTimeout(timeoutHandle)
	}
}

export async function collectJobsHealthComponents(
	env: JobsHealthEnv,
): Promise<JobsHealthComponentsReport> {
	const jobsDb = await checkJobsDb(env.JOBS_DB)
	const temporalScheduleSync =
		jobsDb.ok && env.JOBS_DB
			? await collectTemporalScheduleDiagnostics(env.JOBS_DB)
			: undefined
	return {
		ok: jobsDb.ok,
		commit: env.APP_COMMIT_SHA ?? null,
		checkedAt: new Date().toISOString(),
		components: [jobsDb],
		...(temporalScheduleSync ? { temporalScheduleSync } : {}),
	}
}

export async function handleJobsHealthRequest(
	request: Request,
	env: JobsHealthEnv,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		return Response.json(
			{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
			{ headers: noStoreHeaders },
		)
	}
	if (url.pathname === '/health/components') {
		const report = await collectJobsHealthComponents(env)
		return Response.json(report, {
			status: report.ok ? 200 : 503,
			headers: noStoreHeaders,
		})
	}
	return null
}
