import { expect, test, vi } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { createEgressHandler, egressFetch } from './egress-proxy.ts'

test('egress resolves credentials at the proxy, checks hosts and fails closed on the meter', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	const outbound = vi.fn(
		async (_request: Request | string | URL) => new Response('ok'),
	)
	const tokenClaims = {
		userId: 'alice',
		runId: 'run',
		expiresAt: Date.now() + 60000,
		retriever: false,
		provenance: [
			{ moduleId: 'main', packageId: null, storageId: 'execute:run' },
		],
	}
	const token = await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, tokenClaims)
	await env.APP_DB.prepare(
		"INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow) VALUES ('alice', 'example', 'custom', 'mock', 'https://api.example.com/token', 'https://api.example.com', 'pkce')",
	).run()
	await env.APP_DB.prepare(
		"INSERT INTO user_integrations (user_id, name, app_slug, required_hosts_json) VALUES ('alice', 'example', 'example', '[\"api.example.com\"]')",
	).run()
	try {
		env.vault.store('alice', 'example', 'bearer-token')
		env.kv.put({
			pk: 'alice:meters',
			sk: 'outbound_fetches_per_day',
			remaining: 1,
		})
		const base = {
			env,
			runToken: token,
			resolve: async () => [{ address: '93.184.216.34', family: 4 }],
			connect: outbound,
			requiredHosts: ['api.example.com'],
			allowlist: ['api.example.com'],
		}
		const response = await egressFetch({
			...base,
			url: 'https://api.example.com/items?token={{integration-token:example}}',
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
			egressFetch({
				...base,
				url: 'https://assistant.example.com/private',
				allowlist: ['assistant.example.com'],
				requiredHosts: ['assistant.example.com'],
				context: {
					baseUrl: 'https://assistant.example.com',
					userId: 'alice',
					email: null,
					storageContext: null,
				},
			}),
		).rejects.toThrow('host')
		await expect(
			egressFetch({ ...base, url: 'https://other.example.com/' }),
		).rejects.toThrow('host')
		await expect(
			egressFetch({
				...base,
				runToken: await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
					...tokenClaims,
					retriever: true,
				}),
				url: 'https://api.example.com/',
			}),
		).rejects.toThrow('retriever')
		await expect(
			egressFetch({
				...base,
				resolve: async () => [{ address: '127.0.0.1', family: 4 }],
				url: 'https://api.example.com/',
			}),
		).rejects.toThrow('host')
		await expect(
			egressFetch({
				...base,
				url: 'https://api.example.com/',
				runToken: token + 'tampered',
			}),
		).rejects.toThrow('token')
		await expect(
			egressFetch({ ...base, url: 'https://api.example.com/again' }),
		).rejects.toThrow('entitlement')
		env.kv.put({
			pk: 'alice:meters',
			sk: 'outbound_fetches_per_day',
			remaining: 10,
		})
		for (const address of [
			'::ffff:127.0.0.1',
			'169.254.169.254',
			'10.0.0.1',
			'fc00::1',
			'fe80::1',
			'fec0::1',
			'64:ff9b:1::a00:1',
		])
			await expect(
				egressFetch({
					...base,
					resolve: async () => [
						{ address, family: address.includes(':') ? 6 : 4 },
					],
					url: 'https://api.example.com/',
				}),
			).rejects.toThrow('blocked')
		const handler = createEgressHandler({
			signingKey: env.RUN_TOKEN_SIGNING_KEY,
			forUser: (userId) => {
				expect(userId).toBe('alice')
				return env
			},
			resolve: base.resolve,
			connect: outbound,
		})
		const unregister = handler.register({
			userId: 'alice',
			runId: 'run',
			context: {
				userId: 'alice',
				baseUrl: 'https://kody.codes',
				email: null,
				storageContext: null,
			},
		})
		const proxyRequest = () =>
			new Request('http://api.example.com/items', {
				headers: {
					'x-kody-run-token': token,
					'x-kody-outbound-proto': 'https',
					host: 'evil.example.com',
				},
			})
		expect((await handler.fetch(proxyRequest())).status).toBe(200)
		const forwarded = outbound.mock.calls.at(-1)![0] as Request
		expect(forwarded.url).toBe('https://api.example.com/items')
		expect(forwarded.headers.has('x-kody-run-token')).toBe(false)
		expect(forwarded.headers.has('x-kody-outbound-proto')).toBe(false)
		expect(forwarded.headers.has('host')).toBe(false)
		unregister()
		expect((await handler.fetch(proxyRequest())).status).toBe(403)
	} finally {
		await close()
	}
})
