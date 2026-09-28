import { describe, expect, test } from 'vitest'
import { createTemporalSignature, verifyTemporalSignature } from './signing.ts'

const key = {
	id: 'current',
	secret: 'a-secure-test-secret-that-is-long-enough',
}

describe('Temporal request signing', () => {
	test('accepts a valid request once and rejects its replay', async () => {
		const body = JSON.stringify({ workflowId: 'workflow-1' })
		const timestampMs = Date.UTC(2026, 8, 22, 12)
		const headers = new Headers(
			await createTemporalSignature({
				key,
				method: 'POST',
				pathname: '/v1/workflows/start',
				body,
				idempotencyKey: 'request-1',
				nonce: 'nonce-1',
				timestampMs,
			}),
		)
		const consumed = new Set<string>()
		const verify = () =>
			verifyTemporalSignature({
				keys: [key],
				headers,
				method: 'POST',
				pathname: '/v1/workflows/start',
				body,
				nowMs: timestampMs,
				consumeNonce: async ({ keyId, nonce }) => {
					const compound = `${keyId}:${nonce}`
					if (consumed.has(compound)) return false
					consumed.add(compound)
					return true
				},
			})

		await expect(verify()).resolves.toMatchObject({ ok: true })
		await expect(verify()).resolves.toEqual({ ok: false, code: 'replayed' })
	})

	test('rejects expired and body-tampered requests before consuming nonce', async () => {
		const timestampMs = Date.UTC(2026, 8, 22, 12)
		const headers = new Headers(
			await createTemporalSignature({
				key,
				method: 'POST',
				pathname: '/v1/workflows/start',
				body: '{}',
				idempotencyKey: 'request-2',
				timestampMs,
			}),
		)
		let consumed = false
		const base = {
			keys: [key],
			headers,
			method: 'POST',
			pathname: '/v1/workflows/start',
			consumeNonce: async () => {
				consumed = true
				return true
			},
		}
		await expect(
			verifyTemporalSignature({
				...base,
				body: '{}',
				nowMs: timestampMs + 5 * 60_000 + 1,
			}),
		).resolves.toEqual({ ok: false, code: 'expired' })
		await expect(
			verifyTemporalSignature({
				...base,
				body: '{"tampered":true}',
				nowMs: timestampMs,
			}),
		).resolves.toEqual({ ok: false, code: 'invalid_digest' })
		expect(consumed).toBe(false)
	})
})
