import { expect, test, vi } from 'vitest'
import {
	handleTemporalFoundationSmokeRequest,
	runTemporalFoundationSmokeCheck,
} from './maintenance.ts'

const key = {
	id: 'current',
	secret: 'a-secure-test-secret-that-is-long-enough',
}

function env() {
	return {
		CAPABILITY_REINDEX_SECRET: 'maintenance-secret',
		TEMPORAL_GATEWAY_URL: 'https://temporal-gateway.test',
		TEMPORAL_GATEWAY_SIGNING_KEYS: JSON.stringify([key]),
	} as never
}

test('preview smoke path starts a signed foundation workflow with opaque test references', async () => {
	const requestFetch = vi.fn(
		async (_request: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.method).toBe('POST')
			expect(new Headers(init?.headers).get('x-kody-signature')).toBeTruthy()
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>
			expect(body['workflowType']).toBe('temporalFoundationWorkflow')
			expect(JSON.stringify(body)).not.toContain('example.com')
			return Response.json(
				{
					workflowId: body['workflowId'],
					firstExecutionRunId: 'temporal-run-1',
				},
				{ status: 202 },
			)
		},
	)
	const result = await runTemporalFoundationSmokeCheck(env(), requestFetch)
	expect(result).toMatchObject({
		firstExecutionRunId: 'temporal-run-1',
		proves: 'cloudflare-to-temporal-to-cloudflare-signed-round-trip',
	})
	expect(result.workflowId).toMatch(/^temporal-foundation-smoke-/)
})

test('preview smoke endpoint keeps the existing maintenance authorization boundary', async () => {
	const unauthorized = await handleTemporalFoundationSmokeRequest(
		new Request('https://kody.test/__maintenance/temporal-foundation-smoke', {
			method: 'POST',
		}),
		env(),
	)
	expect(unauthorized.status).toBe(401)
})
