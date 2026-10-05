import { type seedDemo } from './seed.ts'
import { Runtime } from '@temporalio/worker'
import { randomUUID } from 'node:crypto'
import getPort from 'get-port'
import { startLocalPoc } from './bootstrap.ts'
import {
	acquireDemoLock,
	clearDemoState,
	writeDemoState,
	demoControl,
} from './state.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'

export async function launchDemo() {
	const requestedBackend = process.env.KODY_RUNNER_BACKEND ?? 'deno'
	if (requestedBackend !== 'deno')
		throw new Error(
			'KODY_RUNNER_BACKEND must be deno; the workerd comparison backend is retired.',
		)
	const runnerBackend = requestedBackend
	const port = await getPort({
		host: '127.0.0.1',
		port: Number(process.env.PORT ?? 3742),
	})
	const uiPort = await getPort({ host: '127.0.0.1', port: 8233 })
	const token = randomUUID()
	await acquireDemoLock(token)
	let runtime: Awaited<ReturnType<typeof startLocalPoc>>
	let seed: Awaited<ReturnType<typeof seedDemo>>
	let resetting = false
	let retryAttempts = 0
	const failed = new Set<string>()
	let starting: Promise<Awaited<ReturnType<typeof startLocalPoc>>> | undefined
	function start() {
		return (starting = createRuntime())
	}
	async function createRuntime() {
		retryAttempts = 0
		failed.clear()
		return startLocalPoc({
			port,
			uiPort,
			runnerBackend,
			decorateActivities(activities) {
				return {
					...activities,
					async executePackageWorkflow(input) {
						if (input.payload.workflowName === 'demo-pre-execution-retry') {
							retryAttempts++
							if (!failed.has(input.id)) {
								failed.add(input.id)
								throw new Error(
									'Controlled demo failure before package execution.',
								)
							}
						}
						return activities.executePackageWorkflow!(input)
					},
				}
			},
			async beforeServe(env, context) {
				const module = (await context.loadModule(
					'/tools/demo/seed.ts',
				)) as unknown as { seedDemo: typeof seedDemo }
				seed = await module.seedDemo(env, context.fixture)
			},
			async control(request) {
				const path = new URL(request.url).pathname
				if (!path.startsWith('/__demo/')) return undefined
				if (request.headers.get('authorization') !== `Bearer ${token}`)
					return new Response(null, { status: 403 })
				if (resetting) return new Response('Reset in progress', { status: 503 })
				if (path === '/__demo/info' && request.method === 'GET')
					return Response.json({ ...seed, retryAttempts })
				if (path === '/__demo/restart-workers' && request.method === 'POST') {
					await runtime.env.restartWorkers()
					return Response.json({ ok: true })
				}
				if (path === '/__demo/reset' && request.method === 'POST') {
					resetting = true
					// Respond before closing this HTTP server; recreate only this launcher's owned stores.
					setTimeout(
						() =>
							void (async () => {
								await runtime.close()
								if (closing) return
								runtime = await start()
								if (closing) {
									await runtime.close()
									return
								}
								resetting = false
							})().catch((error: unknown) => {
								console.error('Demo reset failed', error)
								void close(1)
							}),
						100,
					)
					return Response.json({ resetting: true })
				}
				return new Response(null, { status: 404 })
			},
		})
	}
	let closing = false
	async function close(code = 0) {
		if (closing) return
		closing = true
		try {
			const owned = await starting?.catch(() => undefined)
			await owned?.close()
		} finally {
			await clearDemoState(token)
			await Runtime.instance().shutdown()
			process.exitCode = code
		}
	}
	process.once('SIGINT', () => void close())
	process.once('SIGTERM', () => void close())
	try {
		runtime = await start()
		if (closing) return
		await writeDemoState({
			origin: runtime.origin,
			token,
			pid: process.pid,
			temporalUi: `http://127.0.0.1:${uiPort}`,
		})
		console.info(
			`Kody demo: ${runtime.origin}\nRunner: ${runnerBackend}\nTemporal UI: http://127.0.0.1:${uiPort}\nAlice: alice@example.invalid / demo-password-123\nBob: bob@example.invalid / demo-password-123\nSynthetic local services; run npm run demo:run in another terminal. Ctrl+C closes this session.`,
		)
	} catch (error) {
		await close(1)
		throw error
	}
}

export async function resetDemo() {
	const before = (await demoControl('info')) as { packageId: string }
	await demoControl('reset', {})
	const deadline = Date.now() + 180000
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 500))
		try {
			const after = (await demoControl('info')) as { packageId: string }
			if (after.packageId !== before.packageId) {
				console.info('Demo reset complete.')
				return
			}
		} catch {}
		if (Date.now() > deadline)
			throw new Error('Demo reset timed out; check the launcher output.')
	}
}

if (isExecutedDirectly(import.meta.url))
	void (process.argv.includes('--reset') ? resetDemo() : launchDemo()).catch(
		(error: unknown) => {
			console.error(error)
			process.exitCode = 1
		},
	)
