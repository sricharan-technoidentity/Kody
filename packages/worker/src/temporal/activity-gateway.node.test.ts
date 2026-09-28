import { expect, test, vi } from 'vitest'
import { createTemporalSignature } from '@kody-internal/shared/temporal/signing.ts'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { UserCodeError } from '#worker/user-code-error.ts'
import { handleTemporalActivityRequest } from './activity-gateway.ts'

const key = {
	id: 'current',
	secret: 'a-secure-test-secret-that-is-long-enough',
}
const path = '/__temporal/v1/packages/resolve'
const input = {
	workflowId: 'workflow-1',
	temporalRunId: 'run-1',
	userHash: 'user-hash-1',
	sourceRef: `artifact:source-1@${'a'.repeat(40)}`,
}

async function signedRequest(body = JSON.stringify(input)) {
	return new Request(`https://kody.test${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(await createTemporalSignature({
				key,
				method: 'POST',
				pathname: path,
				body,
				idempotencyKey: 'resolve-1',
				nonce: 'nonce-1',
			})),
		},
		body,
	})
}

async function signedActivityRequest(input: {
	path: string
	body: Record<string, unknown>
	idempotencyKey: string
	nonce: string
}) {
	const body = JSON.stringify(input.body)
	return new Request(`https://kody.test${input.path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(await createTemporalSignature({
				key,
				method: 'POST',
				pathname: input.path,
				body,
				idempotencyKey: input.idempotencyKey,
				nonce: input.nonce,
			})),
		},
		body,
	})
}

test('signed Activity requests validate, correlate, and reject replay', async () => {
	const nonces = new Set<string>()
	const resolvePackage = vi.fn(async () => ({
		executionPlanRef: input.sourceRef,
	}))
	const dependencies = {
		consumeNonce: async ({
			keyId,
			nonce,
		}: {
			keyId: string
			nonce: string
		}) => {
			const compound = `${keyId}:${nonce}`
			if (nonces.has(compound)) return false
			nonces.add(compound)
			return true
		},
		resolvePackage,
	}
	const env = {
		CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
	} as never

	const response = await handleTemporalActivityRequest(
		await signedRequest(),
		env,
		dependencies,
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		correlation: {
			workflowId: 'workflow-1',
			temporalRunId: 'run-1',
			userHash: 'user-hash-1',
		},
		result: { executionPlanRef: input.sourceRef },
	})
	expect(resolvePackage).toHaveBeenCalledWith(input)
	expect(consoleInfo).toHaveBeenCalledWith('temporal_activity_gateway_auth', {
		path,
		outcome: 'verified',
	})

	const replay = await handleTemporalActivityRequest(
		await signedRequest(),
		env,
		dependencies,
	)
	expect(replay.status).toBe(401)
	expect(await replay.json()).toEqual({ error: 'replayed' })
	expect(consoleInfo).toHaveBeenLastCalledWith(
		'temporal_activity_gateway_auth',
		{ path, outcome: 'replayed' },
	)
})

test('Activity gateway fails closed when signing is not configured', async () => {
	const response = await handleTemporalActivityRequest(
		await signedRequest(),
		{} as never,
	)
	expect(response.status).toBe(503)
})

test('job Activities require the occurrence-derived idempotency key', async () => {
	const jobPath = '/__temporal/v1/jobs/claim'
	const jobInput = {
		workflowId: 'workflow-1',
		userHash: 'user-hash-1',
		jobId: 'job-hash-1',
		runRef: 'run-ref-1',
		scheduledFor: '2026-09-23T00:00:00.000Z',
		trigger: 'scheduled',
	}
	const body = JSON.stringify(jobInput)
	const claimJob = vi.fn(async () => ({
		claimed: true,
		claimRef: 'claim-1',
	}))
	const request = new Request(`https://kody.test${jobPath}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(await createTemporalSignature({
				key,
				method: 'POST',
				pathname: jobPath,
				body,
				idempotencyKey: 'wrong-key',
				nonce: 'job-nonce-1',
			})),
		},
		body,
	})
	const response = await handleTemporalActivityRequest(
		request,
		{
			CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
		} as never,
		{
			consumeNonce: async () => true,
			resolvePackage: async () => ({ executionPlanRef: 'unused' }),
			claimJob,
		},
	)

	expect(response.status).toBe(400)
	expect(await response.json()).toEqual({ error: 'idempotency_key_mismatch' })
	expect(claimJob).not.toHaveBeenCalled()
})

test('dynamic workflow execution requires its stable workflow idempotency key', async () => {
	const executePath = '/__temporal/v1/packages/execute'
	const executeInput = {
		workflowId: 'package-workflow-1',
		temporalRunId: 'temporal-run-1',
		userHash: 'user-hash-1',
		workflowRunId: 'dynwf-run-1',
		sourceRef: `artifact:workflow-source.${'a'.repeat(32)}@${'b'.repeat(64)}`,
		callerContextRef: `artifact:workflow-caller.${'a'.repeat(32)}@${'c'.repeat(64)}`,
		invocationIdempotencyKey: 'opaque-invocation-key',
	}
	const body = JSON.stringify(executeInput)
	const executeDynamicPackage = vi.fn(async () => ({
		status: 'succeeded' as const,
		finishedAt: '2026-09-23T00:00:00.000Z',
		resultRef: 'workflow:dynwf-run-1',
	}))
	const request = new Request(`https://kody.test${executePath}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(await createTemporalSignature({
				key,
				method: 'POST',
				pathname: executePath,
				body,
				idempotencyKey: 'workflow:dynwf-run-1:execute',
				nonce: 'dynamic-nonce-1',
			})),
		},
		body,
	})
	const response = await handleTemporalActivityRequest(
		request,
		{
			CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
		} as never,
		{
			consumeNonce: async () => true,
			resolvePackage: async () => ({ executionPlanRef: 'unused' }),
			executeDynamicPackage,
		},
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		result: {
			status: 'succeeded',
			resultRef: 'workflow:dynwf-run-1',
		},
	})
	expect(executeDynamicPackage).toHaveBeenCalledWith(
		executeInput,
		expect.any(AbortSignal),
		undefined,
	)
})

test('Stripe coordinator Activity requires its Workflow-run idempotency key', async () => {
	const refreshInput = {
		workflowId: 'kody-stripe-plan-refresh-v1:opaque',
		temporalRunId: 'temporal-run-1',
		userHash: 'user-hash-1',
		coordinatorRef: `coordinator:stripe-plan-refresh.${'a'.repeat(32)}`,
		refreshAt: '2026-09-23T14:00:00.000Z',
	}
	const refreshStripePlan = vi.fn(async () => ({
		status: 'refreshed' as const,
	}))
	const response = await handleTemporalActivityRequest(
		await signedActivityRequest({
			path: '/__temporal/v1/coordinators/stripe-plan-refresh',
			body: refreshInput,
			idempotencyKey: 'stripe-plan-refresh:temporal-run-1',
			nonce: 'stripe-refresh-1',
		}),
		{
			CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
		} as never,
		{
			consumeNonce: async () => true,
			resolvePackage: async () => ({ executionPlanRef: 'unused' }),
			refreshStripePlan,
		},
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		correlation: {
			workflowId: refreshInput.workflowId,
			temporalRunId: refreshInput.temporalRunId,
			userHash: refreshInput.userHash,
		},
		result: { status: 'refreshed' },
	})
	expect(refreshStripePlan).toHaveBeenCalledWith(refreshInput)
})

test.each([
	{
		name: 'deterministic package failure',
		error: new UserCodeError('invalid package input'),
		status: 422,
		body: { error: 'package_execution_rejected' },
	},
	{
		name: 'transient package failure',
		error: Object.assign(new Error('temporarily unavailable'), {
			name: 'TransientDynamicWorkflowError',
		}),
		status: 503,
		body: { error: 'transient_package_execution_failure' },
	},
	{
		name: 'unexpected platform failure',
		error: new Error('unexpected failure'),
		status: 500,
		body: { error: 'package_execution_unavailable' },
	},
])('$name is classified for Temporal retry policy', async (testCase) => {
	const workflowRunId = `dynwf-${testCase.status}`
	const executeInput = {
		workflowId: 'package-workflow-1',
		temporalRunId: 'temporal-run-1',
		userHash: 'user-hash-1',
		workflowRunId,
		sourceRef: `artifact:workflow-source.${'a'.repeat(32)}@${'b'.repeat(64)}`,
		callerContextRef: `artifact:workflow-caller.${'a'.repeat(32)}@${'c'.repeat(64)}`,
		invocationIdempotencyKey: 'opaque-invocation-key',
	}
	const response = await handleTemporalActivityRequest(
		await signedActivityRequest({
			path: '/__temporal/v1/packages/execute',
			body: executeInput,
			idempotencyKey: `workflow:${workflowRunId}:execute`,
			nonce: `classification-${testCase.status}`,
		}),
		{
			CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
		} as never,
		{
			consumeNonce: async () => true,
			resolvePackage: async () => ({ executionPlanRef: 'unused' }),
			executeDynamicPackage: async () => {
				throw testCase.error
			},
		},
	)

	expect(response.status).toBe(testCase.status)
	expect(await response.json()).toEqual(testCase.body)
})

test('job package execution receives the request cancellation signal', async () => {
	const executeInput = {
		workflowId: 'job-workflow-1',
		temporalRunId: 'temporal-run-1',
		userHash: 'user-hash-1',
		jobId: 'job-hash-1',
		runRef: 'run-ref-1',
		claimRef: 'claim-ref-1',
		executionPlanRef: 'job-plan:claim-ref-1',
	}
	const executePackage = vi.fn(async () => ({
		status: 'succeeded' as const,
		finishedAt: '2026-09-23T00:00:00.000Z',
		resultRef: 'run:run-ref-1',
	}))
	const response = await handleTemporalActivityRequest(
		await signedActivityRequest({
			path: '/__temporal/v1/packages/execute',
			body: executeInput,
			idempotencyKey: 'job:claim-ref-1:execute',
			nonce: 'job-execution-signal',
		}),
		{
			CLOUDFLARE_ACTIVITY_SIGNING_KEYS: JSON.stringify([key]),
		} as never,
		{
			consumeNonce: async () => true,
			resolvePackage: async () => ({ executionPlanRef: 'unused' }),
			executePackage,
		},
	)

	expect(response.status).toBe(200)
	expect(executePackage).toHaveBeenCalledWith(
		executeInput,
		expect.any(AbortSignal),
		undefined,
	)
})
