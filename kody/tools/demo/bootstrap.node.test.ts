import { expect, test } from 'vitest'
import { access } from 'node:fs/promises'
import getPort from 'get-port'
import { startLocalPoc } from './bootstrap.ts'
import { prepareTemporal } from './prepare-temporal.ts'
import { startWorkerdRunner } from '#worker/runner/supervisor.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'

test('an unavailable explicit Temporal binary fails before starting services', async () => {
	await expect(
		prepareTemporal('/tmp/kody-nonexistent-demo-temporal'),
	).rejects.toThrow('Temporal executable is unavailable')
})
test('a seed failure disposes the partial native runtime and source fixture', async () => {
	const port = await getPort({ host: '127.0.0.1' })
	let sourceDirectory = ''
	await expect(
		startLocalPoc({
			port,
			async beforeServe(_env, { fixture }) {
				sourceDirectory = fixture.directory
				throw new Error('Controlled seed failure')
			},
		}),
	).rejects.toThrow('Controlled seed failure')
	await expect(access(sourceDirectory)).rejects.toMatchObject({
		code: 'ENOENT',
	})
	await using rebound = await startFrontDoorServer({
		port,
		async fetch() {
			return new Response('rebound')
		},
	})
	expect(await (await fetch(rebound.origin)).text()).toBe('rebound')
}, 180000)

test('closing the supervisor stops the actual native workerd listener', async () => {
	const runner = await startWorkerdRunner({
		brokerUrl: 'http://127.0.0.1:1',
		egressUrl: 'http://127.0.0.1:1',
		async readObject() {
			throw new Error('No invocation expected')
		},
	})
	expect((await fetch(`${runner.url}/ping`)).ok).toBe(true)
	await runner[Symbol.asyncDispose]()
	await expect(
		fetch(`${runner.url}/ping`, { signal: AbortSignal.timeout(1000) }),
	).rejects.toThrow('fetch failed')
}, 20000)
