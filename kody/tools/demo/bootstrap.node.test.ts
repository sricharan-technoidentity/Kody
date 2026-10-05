import { expect, test } from 'vitest'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import getPort from 'get-port'
import { startLocalPoc } from './bootstrap.ts'
import { prepareTemporal } from './prepare-temporal.ts'
import { startRunnerHost } from './runner-host.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { demoControl } from './state.ts'
import { launchDemo } from './launcher.ts'

test('an unavailable explicit Temporal binary fails before starting services', async () => {
	await expect(
		prepareTemporal('/tmp/kody-nonexistent-demo-temporal'),
	).rejects.toThrow('Temporal executable is unavailable')
})
test('an invalid runner selection fails before acquiring demo state', async () => {
	const previous = process.env.KODY_RUNNER_BACKEND
	process.env.KODY_RUNNER_BACKEND = 'unsupported'
	try {
		await expect(launchDemo()).rejects.toThrow(
			'KODY_RUNNER_BACKEND must be deno',
		)
	} finally {
		if (previous === undefined) delete process.env.KODY_RUNNER_BACKEND
		else process.env.KODY_RUNNER_BACKEND = previous
	}
})

test('the local application can explicitly select Deno and restart workers', async () => {
	const port = await getPort({ host: '127.0.0.1' })
	const demo = await startLocalPoc({ port, runnerBackend: 'deno' })
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await demo.env.bindings
				.RUNNER_LOADER!.forContext({
					userId: 'alice',
					baseUrl: demo.origin,
					email: null,
					storageContext: null,
				})
				.load({
					mainModule: 'entry.js',
					modules: {
						'entry.js': 'export default {evaluate(){return Deno.version.deno}}',
					},
					compatibilityDate: '2026-04-16',
					compatibilityFlags: [],
				})
				.getEntrypoint()
				.evaluate({}, {})
			expect(result).toBe('2.9.7')
			if (attempt === 0) await demo.env.restartWorkers()
		}
	} finally {
		await demo.close()
	}
	await expect(fetch(demo.origin)).rejects.toThrow('fetch failed')
}, 180000)
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

test('closing a restarted demo releases every Temporal worker connection', async () => {
	const port = await getPort({ host: '127.0.0.1' })
	const demo = await startLocalPoc({ port })
	try {
		await demo.env.restartWorkers()
	} finally {
		await demo.close()
	}
	await expect(fetch(demo.origin)).rejects.toThrow('fetch failed')
}, 180000)

test.each(['SIGINT', 'SIGTERM'] as const)(
	'%s after worker restart cleans up the demo without a Temporal connection error',
	async (signal) => {
		const port = await getPort({ host: '127.0.0.1' })
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL('./launcher.ts', import.meta.url))],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, PORT: String(port) },
			},
		)
		const ready = Promise.withResolvers<void>()
		const exited = Promise.withResolvers<{
			code: number | null
			signal: string | null
		}>()
		let output = ''
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString()
			if (output.includes('Kody demo:')) ready.resolve()
		})
		child.stderr.resume()
		child.once('error', (error) => ready.reject(error))
		child.once('exit', (code, signal) => {
			ready.reject(new Error('Demo exited before readiness.'))
			exited.resolve({ code, signal })
		})
		try {
			await ready.promise
			await demoControl('restart-workers', {})
			child.kill(signal)
			await exited.promise
			expect(child.exitCode).toBe(0)
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL')
				await exited.promise
			}
		}
	},
	180000,
)

test('closing the Deno host stops its HTTP listener', async () => {
	const runner = await startRunnerHost({
		port: 0,
		host: '127.0.0.1',
		allowLocalHttp: true,
		brokerUrl: 'http://127.0.0.1:1',
		egressUrl: 'http://127.0.0.1:1',
		async readObject() {
			throw new Error('No invocation expected')
		},
	})
	expect((await fetch(`${runner.origin}/ping`)).ok).toBe(true)
	await runner.close()
	await expect(
		fetch(`${runner.origin}/ping`, { signal: AbortSignal.timeout(1000) }),
	).rejects.toThrow('fetch failed')
}, 20000)
