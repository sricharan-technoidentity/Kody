import { originWorkerHandler } from '#worker/origin-handler.ts'
import { expect, test } from 'vitest'
import { mcpClientIdMetadataPath } from './client-id-metadata.ts'

async function workerFetch(request: Request) {
	const pending: Promise<unknown>[] = []
	const ctx = {
		waitUntil: (work: Promise<unknown>) => pending.push(work),
		passThroughOnException() {},
		props: {},
	} as unknown as ExecutionContext
	const response = await originWorkerHandler.fetch!(
		request,
		{ APP_BASE_URL: 'https://kody.codes', SENTRY_ENVIRONMENT: 'test' } as Env,
		ctx,
	)
	await Promise.all(pending)
	return response
}

test('worker serves CIMD before the OAuth wrapper and reflects Origin for CORS', async () => {
	const documentUrl = `https://kody.codes${mcpClientIdMetadataPath}`
	const response = await workerFetch(new Request(documentUrl))
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('application/json')
	const body = (await response.json()) as { client_id: string }
	expect(body.client_id).toBe(documentUrl)

	const first = await workerFetch(
		new Request(documentUrl, { headers: { Origin: 'https://as.example' } }),
	)
	const second = await workerFetch(
		new Request(documentUrl, {
			headers: { Origin: 'https://other-as.example' },
		}),
	)
	expect(first.headers.get('Access-Control-Allow-Origin')).toBe(
		'https://as.example',
	)
	expect(second.headers.get('Access-Control-Allow-Origin')).toBe(
		'https://other-as.example',
	)
	expect(first.headers.get('Vary')?.split(/\s*,\s*/)).toContain('Origin')
	expect(second.headers.get('Vary')?.split(/\s*,\s*/)).toContain('Origin')
})
