import { once } from 'node:events'
import { expect, test, vi } from 'vitest'
import { type AddressInfo } from 'node:net'
import { type Client } from '@temporalio/client'
import { createTemporalSignature } from '@kody-internal/shared/temporal/signing.ts'
import {
	createTemporalGatewayServer,
	type TemporalGatewayRequestEvent,
} from './server.ts'

const key = {
	id: 'current',
	secret: 'a-secure-test-secret-that-is-long-enough',
}
const pathname = '/v1/workflows/start'
const body = JSON.stringify({
	workflowType: 'temporalFoundationWorkflow',
	workflowId: 'foundation-smoke-1',
	taskQueue: 'kody-foundation',
	input: {
		workflowId: 'foundation-smoke-1',
		userHash: 'opaque-user-hash',
		sourceRef: `artifact:smoke@${'a'.repeat(40)}`,
	},
})

test('gateway endpoint rejects invalid, expired, and replayed signatures', async () => {
	const events: Array<TemporalGatewayRequestEvent> = []
	const client = {
		workflow: {
			start: async () => ({
				workflowId: 'foundation-smoke-1',
				firstExecutionRunId: 'run-1',
			}),
		},
	} as unknown as Client
	const server = createTemporalGatewayServer({
		client,
		keys: [key],
		recordRequest: (event) => events.push(event),
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	try {
		const address = server.address() as AddressInfo
		const url = `http://127.0.0.1:${String(address.port)}${pathname}`
		const signedHeaders = await createTemporalSignature({
			key,
			method: 'POST',
			pathname,
			body,
			idempotencyKey: 'start:foundation-smoke-1',
			nonce: 'one-use-nonce',
		})
		const valid = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...signedHeaders },
			body,
		})
		expect(valid.status).toBe(202)

		const replay = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...signedHeaders },
			body,
		})
		expect(replay.status).toBe(401)
		await expect(replay.json()).resolves.toEqual({ error: 'replayed' })

		const expiredHeaders = await createTemporalSignature({
			key,
			method: 'POST',
			pathname,
			body,
			idempotencyKey: 'start:foundation-smoke-1',
			timestampMs: Date.now() - 6 * 60_000,
		})
		const expired = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...expiredHeaders },
			body,
		})
		expect(expired.status).toBe(401)
		await expect(expired.json()).resolves.toEqual({ error: 'expired' })

		const invalidHeaders = await createTemporalSignature({
			key,
			method: 'POST',
			pathname,
			body,
			idempotencyKey: 'start:foundation-smoke-1',
		})
		invalidHeaders['x-kody-signature'] = 'invalid'
		const invalid = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...invalidHeaders },
			body,
		})
		expect(invalid.status).toBe(401)
		await expect(invalid.json()).resolves.toEqual({
			error: 'invalid_signature',
		})
		expect(events.map((event) => event.authOutcome)).toEqual([
			'verified',
			'replayed',
			'expired',
			'invalid_signature',
		])
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					route: '/v1/workflows/start',
					method: 'POST',
					status: 202,
				}),
			]),
		)
		expect(JSON.stringify(events)).not.toContain('opaque-user-hash')
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
		})
	}
})

test('gateway validates and dispatches Stripe refresh signal-with-start', async () => {
	const signalWithStart = vi.fn(async () => ({
		workflowId: 'kody-stripe-plan-refresh-v1:opaque',
		signaledRunId: 'run-1',
	}))
	const client = { workflow: { signalWithStart } } as unknown as Client
	const server = createTemporalGatewayServer({ client, keys: [key] })
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	try {
		const address = server.address() as AddressInfo
		const signalPath = '/v1/workflows/signal-with-start'
		const refreshAt = '2026-09-23T14:00:00.000Z'
		const workflowId = 'kody-stripe-plan-refresh-v1:opaque'
		const request = {
			workflowType: 'stripePlanRefreshWorkflow',
			workflowId,
			taskQueue: 'kody-foundation',
			input: {
				workflowId,
				userHash: 'opaque-user-hash',
				coordinatorRef: `coordinator:stripe-plan-refresh.${'a'.repeat(32)}`,
				refreshAt,
			},
			signalName: 'rescheduleStripePlanRefresh',
			signalArgs: [refreshAt],
		}
		const signalBody = JSON.stringify(request)
		const headers = await createTemporalSignature({
			key,
			method: 'POST',
			pathname: signalPath,
			body: signalBody,
			idempotencyKey: `signal-with-start:${workflowId}:rescheduleStripePlanRefresh:${refreshAt}`,
		})
		const response = await fetch(
			`http://127.0.0.1:${String(address.port)}${signalPath}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: signalBody,
			},
		)
		expect(response.status).toBe(202)
		expect(signalWithStart).toHaveBeenCalledWith(
			'stripePlanRefreshWorkflow',
			expect.objectContaining({
				workflowId,
				signal: 'rescheduleStripePlanRefresh',
				signalArgs: [refreshAt],
			}),
		)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
		})
	}
})
