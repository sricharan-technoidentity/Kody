import { expect, test, vi } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { egressFetch } from './egress-proxy.ts'

test('egress resolves credentials at the proxy, checks hosts and fails closed on the meter', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	const outbound = vi.fn(
		async (_request: Request | string | URL) => new Response('ok'),
	)
	vi.stubGlobal('fetch', outbound)
	try {
		env.vault.store('alice', 'example', 'bearer-token')
		env.kv.put({
			pk: 'alice:meters',
			sk: 'outbound_fetches_per_day',
			remaining: 1,
		})
		const base = {
			env,
			runToken: 'signed-execute-token',
			requiredHosts: ['api.example.com'],
			allowlist: ['api.example.com'],
		}
		const response = await egressFetch({
			...base,
			url: 'https://api.example.com/items?token={{example.token}}',
		})
		expect(response.status).toBe(200)
		expect(outbound).toHaveBeenCalledTimes(1)
		const outboundRequest = outbound.mock.calls[0]?.[0]
		expect(
			outboundRequest instanceof Request
				? outboundRequest.url
				: String(outboundRequest),
		).toContain('bearer-token')
		expect(
			env.kv.get('alice:meters', 'outbound_fetches_per_day')?.remaining,
		).toBe(0)
		await expect(
			egressFetch({ ...base, url: 'http://169.254.169.254/latest/meta-data/' }),
		).rejects.toThrow('host')
		await expect(
			egressFetch({ ...base, url: 'http://127.0.0.1/' }),
		).rejects.toThrow('host')
		await expect(
			egressFetch({ ...base, url: 'https://kody.codes/' }),
		).rejects.toThrow('host')
		await expect(
			egressFetch({ ...base, url: 'https://other.example.com/' }),
		).rejects.toThrow('host')
		await expect(
			egressFetch({
				...base,
				runToken: 'signed-retriever-token',
				url: 'https://api.example.com/',
			}),
		).rejects.toThrow('retriever')
		await expect(
			egressFetch({ ...base, url: 'https://api.example.com/again' }),
		).rejects.toThrow('entitlement')
	} finally {
		vi.unstubAllGlobals()
		await close()
	}
})
