import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'
import { invokeDenoSpike } from './deno-spike.ts'
import { prepareDeno } from './prepare-deno.ts'
import {
	parseRunnerInvocation,
	runnerInputKey,
	runnerSessionId,
	awaitRunnerTask,
	type RunnerInvocation,
} from '#worker/runner/contract.ts'

/** AgentCore's HTTP wrapper. Tokens are verified by the trusted broker; no signing key enters this host. */
export async function startRunnerHost(input: {
	brokerUrl: string
	egressUrl: string
	readObject(key: string, signal?: AbortSignal): Promise<RunnerGraph>
	/** Explicit comparison backend only; no automatic fallback after dispatch. */
	execute?(
		graph: RunnerGraph,
		invocation: RunnerInvocation,
		signal: AbortSignal,
	): Promise<unknown>
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
		const executable = input.execute ? undefined : await prepareDeno()
		const controller = new AbortController()
		const running = new Set<Promise<unknown>>()
		stack.defer(async () => {
			controller.abort()
			await Promise.allSettled(running)
		})
		const execute =
			input.execute ??
			((graph, invocation, signal) =>
				invokeDenoSpike({
					graph,
					runToken: invocation.runToken,
					brokerUrl: input.brokerUrl,
					egressUrl: input.egressUrl,
					executable,
					signal,
				}))
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
					const chunks: Array<Uint8Array> = []
					let size = 0
					if (request.body)
						for await (const chunk of request.body.values({
							preventCancel: true,
						})) {
							size += chunk.length
							if (size > 65536)
								return new Response('Payload too large', { status: 413 })
							chunks.push(chunk)
						}
					const text = Buffer.concat(chunks).toString('utf8')
					let payload: RunnerInvocation
					try {
						payload = parseRunnerInvocation(JSON.parse(text))
					} catch {
						return new Response('Invalid invocation', { status: 400 })
					}
					let auth: Response
					try {
						auth = await fetch(new URL('/authorize', input.brokerUrl), {
							method: 'POST',
							headers: { 'x-kody-run-token': payload.runToken },
							signal: AbortSignal.any([
								request.signal,
								controller.signal,
								AbortSignal.timeout(10000),
							]),
							redirect: 'error',
						})
					} catch {
						return new Response(
							'Runner authorization unavailable; broker may have restarted.',
							{ status: 503 },
						)
					}
					if (auth.status >= 500)
						return new Response(
							'Runner authorization unavailable; broker may have restarted.',
							{ status: 503 },
						)
					if (!auth.ok)
						return new Response(
							'Unauthorized: token expired or run registration unavailable.',
							{ status: 401 },
						)
					const claims = (await auth.json()) as {
						userId: string
						runId: string
					}
					let expectedKey: string
					try {
						expectedKey = runnerInputKey(claims.userId, claims.runId)
					} catch {
						return new Response('Invocation owner mismatch', { status: 403 })
					}
					if (
						claims.runId !== payload.runId ||
						payload.bundleKey !== expectedKey
					)
						return new Response('Invocation owner mismatch', { status: 403 })
					const session = request.headers.get(
						'x-amzn-bedrock-agentcore-runtime-session-id',
					)
					if (
						session &&
						session !== runnerSessionId(claims.userId, claims.runId)
					)
						return new Response('Invocation session mismatch', { status: 403 })
					busy(1)
					let task: Promise<unknown> | undefined
					try {
						const signal = AbortSignal.any([request.signal, controller.signal])
						task = (async () => {
							signal.throwIfAborted()
							const readSignal = AbortSignal.any([
								signal,
								AbortSignal.timeout(10_000),
							])
							const graph = await awaitRunnerTask(
								input.readObject(payload.bundleKey, readSignal),
								readSignal,
							)
							signal.throwIfAborted()
							return execute(graph, payload, signal)
						})()
						running.add(task)
						return Response.json(await task)
					} catch {
						return new Response(
							'Runner invocation failed; execution may have completed.',
							{ status: 502 },
						)
					} finally {
						if (task) running.delete(task)
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
			async readObject(key, signal) {
				const object = await objects.get(key, {
					signal,
					maxBytes: 16 * 1024 * 1024,
				})
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
