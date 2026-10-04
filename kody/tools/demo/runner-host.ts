import { startFrontDoorServer } from '#worker/front-door/server.ts'
import {
	startWorkerdRunner,
	type RunnerGraph,
} from '#worker/runner/supervisor.ts'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'
import { resolve } from 'node:path'

/** AgentCore's HTTP wrapper. Tokens are verified by the trusted broker; no signing key enters this host. */
export async function startRunnerHost(input: {
	brokerUrl: string
	egressUrl: string
	readObject(key: string): Promise<RunnerGraph>
	artifactsDirectory?: string
	port?: number
	host?: string
	allowLocalHttp?: boolean
}) {
	for (const endpoint of [input.brokerUrl, input.egressUrl]) {
		const url = new URL(endpoint)
		if (
			url.username ||
			url.password ||
			(url.protocol !== 'https:' &&
				!(
					input.allowLocalHttp &&
					url.hostname === '127.0.0.1' &&
					url.protocol === 'http:'
				))
		)
			throw new Error(
				'Runner requires trusted HTTPS broker and egress endpoints.',
			)
	}
	const stack = new AsyncDisposableStack()
	try {
		// workerd speaks only to these loopback relays. Host fetch applies TLS to the trusted upstreams.
		async function relay(endpoint: string) {
			return stack.use(
				await startFrontDoorServer({
					async fetch(request) {
						const target = new URL(endpoint)
						const original = new URL(request.url)
						target.pathname = original.pathname
						target.search = original.search
						return fetch(target, {
							method: request.method,
							headers: request.headers,
							body: request.body,
							duplex: 'half',
							redirect: 'manual',
							signal: request.signal,
						} as RequestInit)
					},
				}),
			)
		}
		const broker = await relay(input.brokerUrl)
		const egress = await relay(input.egressUrl)
		const runner = stack.use(
			await startWorkerdRunner({
				brokerUrl: broker.origin,
				egressUrl: egress.origin,
				readObject: input.readObject,
				artifactsDirectory: input.artifactsDirectory,
			}),
		)
		let active = 0
		let changedAt = Math.floor(Date.now() / 1000)
		function busy(delta: number) {
			const before = active > 0
			active += delta
			if (before !== active > 0) changedAt = Math.floor(Date.now() / 1000)
		}
		const server = stack.use(
			await startFrontDoorServer({
				port: input.port ?? 8080,
				host: input.host ?? '0.0.0.0',
				async fetch(request) {
					const path = new URL(request.url).pathname
					if (path === '/ping' && request.method === 'GET')
						return Response.json({
							status: active ? 'HealthyBusy' : 'Healthy',
							time_of_last_update: changedAt,
						})
					if (path !== '/invocations' || request.method !== 'POST')
						return new Response('Not found', { status: 404 })
					const text = await request.text()
					if (Buffer.byteLength(text) > 65536)
						return new Response('Payload too large', { status: 413 })
					let payload: { bundleKey: string; runToken: string; runId: string }
					try {
						payload = JSON.parse(text)
						if (
							typeof payload.runToken !== 'string' ||
							typeof payload.runId !== 'string' ||
							typeof payload.bundleKey !== 'string' ||
							Object.keys(payload).some(
								(key) => !['bundleKey', 'runToken', 'runId'].includes(key),
							)
						)
							throw new Error('Invalid invocation')
					} catch {
						return new Response('Invalid invocation', { status: 400 })
					}
					const auth = await fetch(new URL('/authorize', input.brokerUrl), {
						method: 'POST',
						headers: { 'x-kody-run-token': payload.runToken },
						signal: AbortSignal.timeout(10000),
						redirect: 'error',
					})
					if (!auth.ok) return new Response('Unauthorized', { status: 401 })
					const claims = (await auth.json()) as {
						userId: string
						runId: string
					}
					if (
						claims.runId !== payload.runId ||
						payload.bundleKey !==
							`${claims.userId}/runner-inputs/${claims.runId}.json`
					)
						return new Response('Invocation owner mismatch', { status: 403 })
					busy(1)
					try {
						return Response.json(await runner.invoke(payload))
					} finally {
						busy(-1)
					}
				},
			}),
		)
		const owned = stack.move()
		return { origin: server.origin, close: () => owned.disposeAsync() }
	} catch (error) {
		await stack.disposeAsync()
		throw error
	}
}

if (isExecutedDirectly(import.meta.url)) {
	const required = (name: string) => {
		const value = process.env[name]
		if (!value) throw new Error(`Missing ${name}`)
		return value
	}
	void (async () => {
		const objects = createS3Objects({
			region: required('AWS_REGION'),
			bucket: required('S3_BUCKET_BUNDLES'),
		})
		const host = await startRunnerHost({
			brokerUrl: required('BROKER_URL'),
			egressUrl: required('EGRESS_URL'),
			artifactsDirectory: resolve('artifacts'),
			async readObject(key) {
				const object = await objects.get(key)
				if (!object) throw new Error('Referenced graph is unavailable')
				return JSON.parse(await object.text()) as RunnerGraph
			},
		})
		process.once('SIGTERM', () => void host.close())
		process.once('SIGINT', () => void host.close())
	})().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : 'Runner startup failed',
		)
		process.exitCode = 1
	})
}
