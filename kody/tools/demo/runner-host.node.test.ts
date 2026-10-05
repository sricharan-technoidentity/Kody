import { expect, test } from 'vitest'
import { startRunnerHost } from './runner-host.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import { runnerSessionId } from '#worker/runner/contract.ts'
import { vi } from 'vitest'

test('HTTP Runner authorizes the referenced graph before loading it with Deno', async () => {
	const signingKey = 'synthetic-host-test-key-01234567890123456789'
	const broker = createBrokerHandler({ signingKey })
	const unregister = broker.register({
		userId: 'alice',
		runId: 'one',
		async dispatch() {
			return JSON.stringify({ result: 'ok' })
		},
	})
	let brokerUnavailable = false
	await using upstream = await startFrontDoorServer({
		fetch: (request) =>
			brokerUnavailable && new URL(request.url).pathname === '/authorize'
				? new Response('Unavailable', { status: 503 })
				: broker.fetch(request),
	})
	let loads = 0
	const graph: RunnerGraph = {
		mainModule: 'report.js',
		modules: {
			'report.js': `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class Report extends WorkerEntrypoint {async evaluate(){return {report:'synthetic-poc'}}}`,
		},
		compatibilityDate: '2026-04-16',
		compatibilityFlags: ['nodejs_compat'],
	}
	const host = await startRunnerHost({
		port: 0,
		host: '127.0.0.1',
		allowLocalHttp: true,
		brokerUrl: upstream.origin,
		egressUrl: upstream.origin,
		async readObject() {
			loads++
			return graph
		},
	})
	try {
		const ping = await (await fetch(`${host.origin}/ping`)).json()
		expect(ping.status).toBe('Healthy')
		expect(await (await fetch(`${host.origin}/ping`)).json()).toEqual(ping)
		async function invoke(body: unknown) {
			return fetch(`${host.origin}/invocations`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
		}
		const token = await mintRunToken(signingKey, {
			userId: 'alice',
			runId: 'one',
			expiresAt: Date.now() + 60000,
			retriever: false,
			provenance: [
				{ moduleId: 'entry', packageId: null, storageId: 'execute' },
			],
		})
		expect(
			(
				await invoke({
					bundleKey: 'bob/runner-inputs/one.json',
					runId: 'one',
					runToken: token,
				})
			).status,
		).toBe(403)
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'one',
					runToken: 'invalid',
				})
			).status,
		).toBe(401)
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'one',
					runToken: token,
					modules: {},
				})
			).status,
		).toBe(400)
		expect(loads).toBe(0)
		expect((await invoke({ padding: 'x'.repeat(65537) })).status).toBe(413)
		const wrongSession = await fetch(`${host.origin}/invocations`, {
			method: 'POST',
			headers: {
				'x-amzn-bedrock-agentcore-runtime-session-id': runnerSessionId(
					'bob',
					'one',
				),
			},
			body: JSON.stringify({
				bundleKey: 'alice/runner-inputs/one.json',
				runId: 'one',
				runToken: token,
			}),
		})
		expect(wrongSession.status).toBe(403)
		expect(loads).toBe(0)
		for (const bundleKey of [
			'alice/runner-inputs/../one.json',
			'alice/runner-inputs/two.json',
			'alice/runner-inputs/%6fne.json',
		])
			expect(
				(await invoke({ bundleKey, runId: 'one', runToken: token })).status,
			).toBe(403)
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'two',
					runToken: token,
				})
			).status,
		).toBe(403)
		const expired = await mintRunToken(signingKey, {
			userId: 'alice',
			runId: 'one',
			expiresAt: Date.now() - 1,
			retriever: false,
			provenance: [
				{ moduleId: 'entry', packageId: null, storageId: 'execute' },
			],
		})
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'one',
					runToken: expired,
				})
			).status,
		).toBe(401)
		expect(loads).toBe(0)
		const result = await invoke({
			bundleKey: 'alice/runner-inputs/one.json',
			runId: 'one',
			runToken: token,
		})
		expect(result.status).toBe(200)
		expect(await result.json()).toEqual({ report: 'synthetic-poc' })
		expect(loads).toBe(1)
		brokerUnavailable = true
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'one',
					runToken: token,
				})
			).status,
		).toBe(503)
		expect(loads).toBe(1)
		brokerUnavailable = false
		unregister()
		expect(
			(
				await invoke({
					bundleKey: 'alice/runner-inputs/one.json',
					runId: 'one',
					runToken: token,
				})
			).status,
		).toBe(401)
	} finally {
		unregister()
		await host.close()
	}
}, 60000)

test('host reports busy until execution ends and cancels owned work on close', async () => {
	const signingKey = 'synthetic-busy-test-signing-key-0123456789'
	const broker = createBrokerHandler({ signingKey })
	const unregister = broker.register({
		userId: 'alice',
		runId: 'busy',
		async dispatch() {
			throw new Error('Unused')
		},
	})
	await using upstream = await startFrontDoorServer({ fetch: broker.fetch })
	const started = Promise.withResolvers<void>()
	let settled = false
	const host = await startRunnerHost({
		port: 0,
		host: '127.0.0.1',
		allowLocalHttp: true,
		brokerUrl: upstream.origin,
		egressUrl: upstream.origin,
		async readObject() {
			return {
				mainModule: 'unused',
				modules: {},
				compatibilityDate: '2026-04-16',
				compatibilityFlags: [],
			}
		},
		async execute(_graph, _invocation, signal) {
			started.resolve()
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => resolve(), { once: true }),
			)
			settled = true
			throw new Error('Cancelled')
		},
	})
	try {
		const runToken = await mintRunToken(signingKey, {
			userId: 'alice',
			runId: 'busy',
			expiresAt: Date.now() + 60000,
			retriever: false,
			provenance: [
				{ moduleId: 'entry', packageId: null, storageId: 'execute' },
			],
		})
		const request = fetch(`${host.origin}/invocations`, {
			method: 'POST',
			body: JSON.stringify({
				bundleKey: 'alice/runner-inputs/busy.json',
				runId: 'busy',
				runToken,
			}),
		}).catch(() => null)
		await started.promise
		const busy = await (await fetch(`${host.origin}/ping`)).json()
		expect(busy.status).toBe('HealthyBusy')
		expect(await (await fetch(`${host.origin}/ping`)).json()).toEqual(busy)
		await host.close()
		expect(settled).toBe(true)
		await request
	} finally {
		unregister()
		await host.close()
	}
})

test('closing during a delayed graph read prevents a late dispatch', async () => {
	const entered = Promise.withResolvers<void>()
	const graph = Promise.withResolvers<RunnerGraph>()
	const execute = vi.fn()
	await using upstream = await startFrontDoorServer({
		fetch: async () => Response.json({ userId: 'alice', runId: 'delayed' }),
	})
	const host = await startRunnerHost({
		port: 0,
		host: '127.0.0.1',
		allowLocalHttp: true,
		brokerUrl: upstream.origin,
		egressUrl: upstream.origin,
		execute,
		async readObject(_key, signal) {
			expect(signal).toBeInstanceOf(AbortSignal)
			entered.resolve()
			return graph.promise
		},
	})
	const request = fetch(`${host.origin}/invocations`, {
		method: 'POST',
		body: JSON.stringify({
			bundleKey: 'alice/runner-inputs/delayed.json',
			runId: 'delayed',
			runToken: 'synthetic',
		}),
	}).catch(() => null)
	try {
		await entered.promise
		await host.close()
		graph.resolve({
			mainModule: 'entry.js',
			modules: {},
			compatibilityDate: '',
			compatibilityFlags: [],
		})
		await request
		expect(execute).not.toHaveBeenCalled()
	} finally {
		await host.close()
	}
})
