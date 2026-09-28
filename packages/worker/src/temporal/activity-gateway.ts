import {
	type ClaimJobRequest,
	type ExecuteDynamicPackageRequest,
	type ExecuteDynamicPackageResult,
	type ExecuteJobPackageRequest,
	type ExecuteJobPackageResult,
	type FinalizeJobRequest,
	type JobOccurrenceClaimResult,
	type ResolvePackageRequest,
	type ResolveJobExecutionPlanRequest,
	type ResolveJobExecutionPlanResult,
	type StripePlanRefreshRequest,
	type StripePlanRefreshResult,
	type TemporalActivityPath,
	type TemporalActivityRequestByPath,
	type TemporalActivityResponse,
} from '@kody-internal/shared/temporal/contracts.ts'
import {
	isTemporalActivityPath,
	parseTemporalActivityRequest,
} from '@kody-internal/shared/temporal/schemas.ts'
import {
	parseTemporalSigningKeys,
	verifyTemporalSignature,
} from '@kody-internal/shared/temporal/signing.ts'
import { type JsonValue } from '@kody-internal/shared/json-safe-value.ts'
import { type JobsServiceContract } from '@kody-internal/shared/jobs/rpc.ts'
import { buildStripePlanRefreshWorkflowId } from '@kody-internal/shared/temporal/identifiers.ts'
import { isUserCodeError, UserCodeError } from '#worker/user-code-error.ts'
import { loadStripePlanRefreshArtifact } from './stripe-plan-refresh-artifact.ts'

const maxRequestBytes = 64 * 1024
const immutableSourceRefPattern =
	/^artifact:[A-Za-z0-9._~-]{1,200}@[a-f0-9]{40,64}$/

type TemporalGatewayEnv = Env & {
	CLOUDFLARE_ACTIVITY_SIGNING_KEYS?: string
}

class TemporalActivityRejectedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'TemporalActivityRejectedError'
	}
}

export type TemporalActivityGatewayDependencies = {
	consumeNonce(input: {
		keyId: string
		nonce: string
		expiresAtMs: number
	}): Promise<boolean>
	resolvePackage(input: ResolvePackageRequest): Promise<JsonValue>
	claimJob?(input: ClaimJobRequest): Promise<JobOccurrenceClaimResult>
	resolveExecutionPlan?(
		input: ResolveJobExecutionPlanRequest,
	): Promise<ResolveJobExecutionPlanResult>
	executePackage?(
		input: ExecuteJobPackageRequest,
		signal?: AbortSignal,
		waitUntil?: (promise: Promise<unknown>) => void,
	): Promise<ExecuteJobPackageResult>
	executeDynamicPackage?(
		input: ExecuteDynamicPackageRequest,
		signal?: AbortSignal,
		waitUntil?: (promise: Promise<unknown>) => void,
	): Promise<ExecuteDynamicPackageResult>
	finalizeJob?(input: FinalizeJobRequest): Promise<{ finalized: boolean }>
	refreshStripePlan?(
		input: StripePlanRefreshRequest,
	): Promise<StripePlanRefreshResult>
}

async function readBoundedBody(request: Request) {
	const declaredLength = Number(request.headers.get('content-length'))
	if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
		throw new Error('request_too_large')
	}
	if (!request.body) return ''
	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let bytes = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		bytes += value.byteLength
		if (bytes > maxRequestBytes) {
			await reader.cancel()
			throw new Error('request_too_large')
		}
		chunks.push(value)
	}
	const joined = new Uint8Array(bytes)
	let offset = 0
	for (const chunk of chunks) {
		joined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(joined)
}

function jsonError(status: number, error: string) {
	return Response.json(
		{ error },
		{ status, headers: { 'cache-control': 'no-store' } },
	)
}

function logActivityGatewayAuthentication(input: {
	path: TemporalActivityPath
	outcome: string
}) {
	console.info('temporal_activity_gateway_auth', input)
}

async function consumeD1Nonce(
	db: D1Database,
	input: { keyId: string; nonce: string; expiresAtMs: number },
) {
	const now = Date.now()
	await db
		.prepare('DELETE FROM temporal_gateway_nonces WHERE expires_at_ms < ?')
		.bind(now)
		.run()
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO temporal_gateway_nonces
				(key_id, nonce, expires_at_ms, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(
			input.keyId,
			input.nonce,
			input.expiresAtMs,
			new Date(now).toISOString(),
		)
		.run()
	return result.meta.changes === 1
}

async function resolveFoundationPackage(input: ResolvePackageRequest) {
	if (!immutableSourceRefPattern.test(input.sourceRef)) {
		throw new UserCodeError('source_ref_not_immutable')
	}
	return { executionPlanRef: input.sourceRef }
}

function defaultDependencies(
	env: TemporalGatewayEnv,
	ctx?: ExecutionContext,
): TemporalActivityGatewayDependencies {
	const jobs = env.JOBS as unknown as JobsServiceContract | undefined
	if (!jobs)
		throw new Error('Temporal job execution requires the JOBS binding.')
	return {
		consumeNonce: (input) => consumeD1Nonce(env.APP_DB, input),
		resolvePackage: resolveFoundationPackage,
		claimJob: async (input) =>
			await jobs.claimTemporalJobOccurrence({
				userHash: input.userHash,
				jobId: input.jobId,
				scheduledFor: input.scheduledFor,
				claimRef: input.runRef,
			}),
		resolveExecutionPlan: async (input) => {
			const row = await jobs.getTemporalClaimedJob({
				userHash: input.userHash,
				jobId: input.jobId,
				claimRef: input.claimRef,
			})
			if (!row) throw new Error('job_claim_not_found')
			return { executionPlanRef: `job-plan:${input.claimRef}` }
		},
		executePackage: async (input, signal, waitUntil) => {
			if (input.executionPlanRef !== `job-plan:${input.claimRef}`) {
				throw new UserCodeError('execution_plan_mismatch')
			}
			const row = await jobs.getTemporalClaimedJob({
				userHash: input.userHash,
				jobId: input.jobId,
				claimRef: input.claimRef,
			})
			if (!row?.claimed_scheduled_for) {
				throw new UserCodeError('job_claim_not_found')
			}
			const { executeClaimedScheduledJobWithResultRef } =
				await import('#worker/jobs/service.ts')
			const execution = await executeClaimedScheduledJobWithResultRef({
				env,
				row,
				scheduledFor: row.claimed_scheduled_for,
				signal,
				waitUntil:
					waitUntil ?? (ctx ? (promise) => ctx.waitUntil(promise) : undefined),
			})
			return {
				status: execution.outcome.execution.ok ? 'succeeded' : 'failed',
				finishedAt: execution.outcome.finishedAt,
				resultRef: execution.resultRef,
				...(execution.outcome.execution.ok
					? {}
					: { errorCode: 'package_execution_failed' }),
			}
		},
		executeDynamicPackage: async (input, signal, waitUntil) => {
			try {
				const { executeTemporalDynamicPackageActivity } =
					await import('#worker/package-runtime/package-workflows.ts')
				return await executeTemporalDynamicPackageActivity({
					env,
					request: input,
					signal,
					waitUntil:
						waitUntil ??
						(ctx ? (promise) => ctx.waitUntil(promise) : undefined),
				})
			} catch (error) {
				if (isUserCodeError(error)) throw error
				const transient = new Error(
					error instanceof Error
						? error.message
						: 'dynamic_workflow_execution_failed',
					{ cause: error },
				)
				transient.name = 'TransientDynamicWorkflowError'
				throw transient
			}
		},
		finalizeJob: async (input) => ({
			finalized: await jobs.finalizeTemporalJobOccurrence({
				userHash: input.userHash,
				jobId: input.jobId,
				claimRef: input.claimRef,
				scheduledFor: input.scheduledFor,
				status: input.status,
				finishedAt: input.finishedAt,
			}),
		}),
		refreshStripePlan: async (input) => {
			const { AccountDeletionInProgressError, withAccountWriteLease } =
				await import('#worker/account/deletion-state.ts')
			let artifact
			try {
				artifact = await loadStripePlanRefreshArtifact({
					kv: env.BUNDLE_ARTIFACTS_KV,
					coordinatorRef: input.coordinatorRef,
					expectedOwnerHash: input.userHash,
				})
				if (
					(await buildStripePlanRefreshWorkflowId(artifact.userId)) !==
					input.workflowId
				) {
					throw new Error('stripe_plan_refresh_workflow_mismatch')
				}
			} catch (error) {
				throw new TemporalActivityRejectedError(
					'stripe_plan_refresh_reference_rejected',
					{
						cause: error,
					},
				)
			}
			try {
				return await withAccountWriteLease({
					db: env.APP_DB,
					stableUserId: artifact.userId,
					holder: 'temporal_stripe_plan_refresh',
					env,
					write: async () => {
						const user = await env.APP_DB.prepare(
							`SELECT id, stripe_customer_id, stripe_plan_refreshed_at, deleting_at
							 FROM users
							 WHERE stable_user_id = ?`,
						)
							.bind(artifact.userId)
							.first<{
								id: number
								stripe_customer_id: string | null
								stripe_plan_refreshed_at: string | null
								deleting_at: string | null
							}>()
						if (!user?.stripe_customer_id) {
							return { status: 'skipped', reason: 'account-not-found' } as const
						}
						if (user.deleting_at) {
							return { status: 'skipped', reason: 'account-deleting' } as const
						}
						if (
							user.stripe_plan_refreshed_at &&
							Date.parse(user.stripe_plan_refreshed_at) >=
								Date.parse(input.refreshAt)
						) {
							return { status: 'skipped', reason: 'already-refreshed' } as const
						}
						const { refreshStripePlanForUser } =
							await import('#worker/billing/subscription-sync.ts')
						await refreshStripePlanForUser({
							env,
							userId: user.id,
							customerId: user.stripe_customer_id,
						})
						return { status: 'refreshed' } as const
					},
				})
			} catch (error) {
				if (error instanceof AccountDeletionInProgressError) {
					return { status: 'skipped', reason: 'account-deleting' }
				}
				throw error
			}
		},
	}
}

async function dispatchActivity<P extends TemporalActivityPath>(
	path: P,
	input: TemporalActivityRequestByPath[P],
	dependencies: TemporalActivityGatewayDependencies,
	signal?: AbortSignal,
	waitUntil?: (promise: Promise<unknown>) => void,
) {
	switch (path) {
		case '/__temporal/v1/packages/resolve':
			if ('sourceRef' in input) {
				return await dependencies.resolvePackage(input as ResolvePackageRequest)
			}
			if (!dependencies.resolveExecutionPlan)
				throw new Error('phase_not_enabled')
			return await dependencies.resolveExecutionPlan(
				input as ResolveJobExecutionPlanRequest,
			)
		case '/__temporal/v1/jobs/claim':
			if (!dependencies.claimJob) throw new Error('phase_not_enabled')
			return await dependencies.claimJob(input as ClaimJobRequest)
		case '/__temporal/v1/jobs/finalize':
			if (!dependencies.finalizeJob) throw new Error('phase_not_enabled')
			return await dependencies.finalizeJob(input as FinalizeJobRequest)
		case '/__temporal/v1/packages/execute':
			if ('workflowRunId' in input) {
				if (!dependencies.executeDynamicPackage) {
					throw new Error('phase_not_enabled')
				}
				return await dependencies.executeDynamicPackage(
					input as ExecuteDynamicPackageRequest,
					signal,
					waitUntil,
				)
			}
			if (!('claimRef' in input) || !dependencies.executePackage) {
				throw new Error('phase_not_enabled')
			}
			return await dependencies.executePackage(
				input as ExecuteJobPackageRequest,
				signal,
				waitUntil,
			)
		case '/__temporal/v1/coordinators/stripe-plan-refresh':
			if (!dependencies.refreshStripePlan) throw new Error('phase_not_enabled')
			return await dependencies.refreshStripePlan(
				input as StripePlanRefreshRequest,
			)
		case '/__temporal/v1/accounts/cancel':
			throw new Error('phase_not_enabled')
	}
}

function expectedJobIdempotencyKey(
	path: TemporalActivityPath,
	input: TemporalActivityRequestByPath[TemporalActivityPath],
) {
	if ('workflowRunId' in input) {
		return `workflow:${input.workflowRunId}:execute`
	}
	if (path === '/__temporal/v1/coordinators/stripe-plan-refresh') {
		const request = input as StripePlanRefreshRequest
		return `stripe-plan-refresh:${request.temporalRunId}`
	}
	if (!('claimRef' in input) && !('runRef' in input)) return null
	switch (path) {
		case '/__temporal/v1/jobs/claim': {
			const request = input as ClaimJobRequest
			return `job:${request.runRef}:claim`
		}
		case '/__temporal/v1/packages/resolve': {
			const request = input as ResolveJobExecutionPlanRequest
			return `job:${request.claimRef}:resolve`
		}
		case '/__temporal/v1/packages/execute': {
			const request = input as ExecuteJobPackageRequest
			return `job:${request.claimRef}:execute`
		}
		case '/__temporal/v1/jobs/finalize': {
			const request = input as FinalizeJobRequest
			return `job:${request.claimRef}:finalize:${request.status}`
		}
		case '/__temporal/v1/accounts/cancel':
			return null
	}
}

export function isTemporalActivityRequest(pathname: string) {
	return pathname.startsWith('/__temporal/')
}

export async function handleTemporalActivityRequest(
	request: Request,
	env: TemporalGatewayEnv,
	dependencies?: TemporalActivityGatewayDependencies,
	ctx?: ExecutionContext,
) {
	const url = new URL(request.url)
	if (!isTemporalActivityPath(url.pathname)) {
		return jsonError(404, 'not_found')
	}
	if (request.method !== 'POST') return jsonError(405, 'method_not_allowed')
	const configuredKeys = env.CLOUDFLARE_ACTIVITY_SIGNING_KEYS?.trim()
	if (!configuredKeys) return jsonError(503, 'temporal_gateway_disabled')
	try {
		const resolvedDependencies = dependencies ?? defaultDependencies(env, ctx)
		const body = await readBoundedBody(request)
		const verification = await verifyTemporalSignature({
			keys: parseTemporalSigningKeys(configuredKeys),
			headers: request.headers,
			method: request.method,
			pathname: url.pathname,
			body,
			consumeNonce: resolvedDependencies.consumeNonce,
		})
		if (!verification.ok) {
			logActivityGatewayAuthentication({
				path: url.pathname,
				outcome: verification.code,
			})
			return jsonError(401, verification.code)
		}
		logActivityGatewayAuthentication({
			path: url.pathname,
			outcome: 'verified',
		})
		const parsed = parseTemporalActivityRequest(
			url.pathname,
			JSON.parse(body) as unknown,
		)
		const expectedIdempotencyKey = expectedJobIdempotencyKey(
			url.pathname,
			parsed,
		)
		if (
			expectedIdempotencyKey &&
			verification.idempotencyKey !== expectedIdempotencyKey
		) {
			return jsonError(400, 'idempotency_key_mismatch')
		}
		let result: JsonValue
		try {
			result = await dispatchActivity(
				url.pathname,
				parsed,
				resolvedDependencies,
				request.signal,
				ctx ? (promise) => ctx.waitUntil(promise) : undefined,
			)
		} catch (error) {
			if (error instanceof TemporalActivityRejectedError) {
				return jsonError(422, 'activity_request_rejected')
			}
			if (isUserCodeError(error)) {
				return jsonError(422, 'package_execution_rejected')
			}
			if (
				error instanceof Error &&
				(error.name === 'TransientJobExecutionError' ||
					error.name === 'TransientDynamicWorkflowError')
			) {
				return jsonError(503, 'transient_package_execution_failure')
			}
			return jsonError(500, 'package_execution_unavailable')
		}
		const response: TemporalActivityResponse = {
			ok: true,
			correlation: {
				workflowId: parsed.workflowId,
				userHash: parsed.userHash,
				...(parsed.temporalRunId
					? { temporalRunId: parsed.temporalRunId }
					: {}),
				...(parsed.jobId ? { jobId: parsed.jobId } : {}),
				...(parsed.runRef ? { runRef: parsed.runRef } : {}),
			},
			result,
		}
		return Response.json(response, {
			headers: { 'cache-control': 'no-store' },
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : 'invalid_request'
		if (message === 'request_too_large') return jsonError(413, message)
		if (message === 'phase_not_enabled') return jsonError(503, message)
		return jsonError(400, message)
	}
}
