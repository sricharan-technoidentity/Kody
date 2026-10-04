import { expect, test } from 'vitest'
import { startRunnerHost } from './runner-host.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'

test('HTTP Runner authorizes the referenced graph before loading it and runs native workerd', async () => {
	const signingKey = 'synthetic-host-test-key-01234567890123456789'
	const broker = createBrokerHandler({ signingKey })
	const unregister = broker.register({
		userId: 'alice',
		runId: 'one',
		async dispatch() {
			return JSON.stringify({ result: 'ok' })
		},
	})
	await using upstream = await startFrontDoorServer({
		fetch: (request) => broker.fetch(request),
	})
	let loads = 0
	const host = await startRunnerHost({
		port: 0,
		host: '127.0.0.1',
		allowLocalHttp: true,
		brokerUrl: upstream.origin,
		egressUrl: upstream.origin,
		async readObject() {
			loads++
			return {
				mainModule: 'report.js',
				modules: {
					'report.js': `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class Report extends WorkerEntrypoint {async evaluate(){return {report:'synthetic-poc'}}}`,
				},
				compatibilityDate: '2026-04-16',
				compatibilityFlags: ['nodejs_compat'],
			}
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
		const result = await invoke({
			bundleKey: 'alice/runner-inputs/one.json',
			runId: 'one',
			runToken: token,
		})
		expect(result.status).toBe(200)
		expect(await result.json()).toEqual({ report: 'synthetic-poc' })
		expect(loads).toBe(1)
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
