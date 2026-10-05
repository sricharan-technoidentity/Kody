import originHandler from './index.ts'
import { createFrontDoorTestEnv } from '#worker/test-support/front-door.ts'
import { expect, test, vi } from 'vitest'
import { isHttpMutation } from '#worker/front-door/handler.ts'
import {
	cliClientIdMetadataPath,
	cliOAuthCallbackUrl,
} from './cli-client-metadata.ts'

async function workerFetch(request: Request) {
	const target = await createFrontDoorTestEnv({
		handler: originHandler,
		origin: 'https://kody.codes',
	})
	const temporal = vi
		.spyOn(target.bindings.TEMPORAL!, 'client')
		.mockRejectedValue(new Error('Temporal is unavailable.'))
	try {
		const response = await target.fetch(request)
		expect(temporal).not.toHaveBeenCalled()
		return response
	} finally {
		await target.close()
	}
}

test('worker serves CLI CIMD before the OAuth wrapper and reflects Origin for CORS', async () => {
	const documentUrl = `https://kody.codes${cliClientIdMetadataPath}`
	for (const method of ['GET', 'HEAD', 'OPTIONS'])
		expect(isHttpMutation(new Request(documentUrl, { method }))).toBe(false)
	expect(isHttpMutation(new Request(documentUrl, { method: 'POST' }))).toBe(
		true,
	)
	expect(isHttpMutation(new Request('https://kody.codes/oauth/callback'))).toBe(
		true,
	)
	const response = await workerFetch(new Request(documentUrl))
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('application/json')
	const body = (await response.json()) as {
		client_id: string
		redirect_uris: Array<string>
	}
	expect(body.client_id).toBe(documentUrl)
	expect(body.redirect_uris).toEqual([cliOAuthCallbackUrl])

	const first = await workerFetch(
		new Request(documentUrl, { headers: { Origin: 'https://as.example' } }),
	)
	expect(first.headers.get('Access-Control-Allow-Origin')).toBe(
		'https://as.example',
	)
	expect(first.headers.get('Vary')?.split(/\s*,\s*/)).toContain('Origin')
})
