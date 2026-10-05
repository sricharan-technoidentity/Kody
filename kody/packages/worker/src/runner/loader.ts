import { type FetchGatewayProps } from '#worker/egress/proxy.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { serializeWorkerLoaderModules } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type RunnerGraph } from './contract.ts'
import {
	runnerInputKey,
	RunnerInvocationError,
	claimRunnerDispatch,
	awaitRunnerTask,
	type RunnerDispatchStore,
	type RunnerInvocation,
} from './contract.ts'

export { packageAppRuntimeMethods } from './bridge-methods.ts'

export type RunnerDispatcher = {
	call(name: string, args: string): Promise<string>
}
export type RunnerWorkerOptions = {
	mainModule: string
	modules: WorkerLoaderModules
	compatibilityDate: string
	compatibilityFlags: Array<string>
	env?: Record<string, unknown>
	runtimeMethods?: Record<string, Array<string>>
	globalOutbound?: unknown
	timeoutMs?: number
}
export type RunnerLoader = ReturnType<typeof createRunnerLoader>

/** Trusted host port. prepare runs in an activity; registrations never enter the sandbox graph. */
export function createRunnerLoader(input: {
	idempotency?: RunnerDispatchStore
	putObject(key: string, graph: RunnerGraph): Promise<void>
	prepare(
		context: FetchGatewayProps,
		runId?: string,
		timeoutMs?: number,
	): Promise<{ runId: string; runToken: string; runtimeSessionId: string }>
	register(run: {
		runId: string
		userId: string
		context: FetchGatewayProps
		dispatch(capability: string, args: unknown): Promise<string>
	}): () => void
	invoke(input: {
		runtimeSessionId: string
		payload: RunnerInvocation
		signal?: AbortSignal
		timeoutMs?: number
	}): Promise<unknown>
}) {
	return {
		forContext(context: FetchGatewayProps) {
			async function invokeGraph(
				graph: RunnerGraph,
				dispatchers: Record<string, RunnerDispatcher> = {},
				runId?: string,
				signal?: AbortSignal,
			) {
				graph = {
					...graph,
					timeoutMs:
						graph.timeoutMs ??
						Math.max(
							90_000,
							(context.outboundFetchTimeoutMs ?? 60_000) + 30_000,
						),
					bodyLimitBytes:
						graph.bodyLimitBytes ??
						(graph.method === 'fetch' ? 32 * 1024 * 1024 : 16 * 1024 * 1024),
					responseLimitBytes:
						graph.responseLimitBytes ??
						(graph.method === 'fetch' ? 48 * 1024 * 1024 : 16 * 1024 * 1024),
				}
				let dispatched = false
				let unregister: (() => void) | undefined
				try {
					if (!context.userId)
						throw new Error('Runner requires a signed-in owner.')
					if (runId) runnerInputKey(context.userId, runId)
					if (runId !== undefined && !input.idempotency)
						throw new Error(
							'Durable Runner execution requires a dispatch ledger.',
						)
					signal?.throwIfAborted()
					const run = await awaitRunnerTask(
						input.prepare(context, runId, graph.timeoutMs),
						signal,
					)
					if (runId !== undefined && run.runId !== runId)
						throw new Error(
							'Runner preparation changed the logical run identity.',
						)
					const bundleKey = runnerInputKey(context.userId, run.runId)
					unregister = input.register({
						runId: run.runId,
						userId: context.userId,
						context,
						async dispatch(capability, args) {
							const separator = capability.indexOf('.')
							const provider = capability.slice(0, separator)
							const name = capability.slice(separator + 1)
							if (separator <= 0 || !dispatchers[provider])
								throw new Error('Unknown runner dispatcher.')
							return dispatchers[provider].call(name, JSON.stringify(args))
						},
					})
					await awaitRunnerTask(input.putObject(bundleKey, graph), signal)
					if (input.idempotency) {
						dispatched = true
						await claimRunnerDispatch(
							input.idempotency,
							context.userId,
							run.runId,
						)
					}
					dispatched = true
					signal?.throwIfAborted()
					return await input.invoke({
						runtimeSessionId: run.runtimeSessionId,
						payload: { bundleKey, runToken: run.runToken, runId: run.runId },
						signal,
						timeoutMs: graph.timeoutMs,
					})
				} catch (error) {
					throw new RunnerInvocationError(dispatched, error)
				} finally {
					unregister?.()
				}
			}
			const load = (options: RunnerWorkerOptions) => ({
				getEntrypoint(entrypointName?: string) {
					async function invoke(
						method: 'evaluate' | 'fetch',
						args: unknown,
						dispatchers: Record<string, RunnerDispatcher> = {},
						signal?: AbortSignal,
					) {
						const methods: Record<string, Array<string>> = {}
						const publicEnv: Record<string, unknown> = {}
						for (const [name, value] of Object.entries(options.env ?? {})) {
							if (
								value &&
								typeof value === 'object' &&
								Object.getPrototypeOf(value) !== Object.prototype
							) {
								const names = options.runtimeMethods?.[name]
								if (!names?.length)
									throw new Error(
										'Runner RPC binding needs an explicit public method list.',
									)
								methods[name] = names
								dispatchers[name] = {
									async call(method, json) {
										if (!names.includes(method))
											throw new Error('Unknown runtime capability.')
										const fn = (
											value as Record<
												string,
												(...args: Array<unknown>) => Promise<unknown>
											>
										)[method]!
										try {
											return JSON.stringify({
												result: await fn.apply(value, JSON.parse(json)),
											})
										} catch (error) {
											return JSON.stringify({
												error:
													error instanceof Error
														? error.message
														: String(error),
											})
										}
									},
								}
							} else {
								publicEnv[name] = value
							}
						}
						const graph: RunnerGraph = {
							timeoutMs: options.timeoutMs,
							// Transport headroom preserves caller-side JSON/media truncation and larger app bodies.
							bodyLimitBytes:
								method === 'fetch' ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
							responseLimitBytes:
								method === 'fetch' ? 48 * 1024 * 1024 : 16 * 1024 * 1024,
							mainModule: options.mainModule,
							modules: serializeWorkerLoaderModules(options.modules),
							compatibilityDate: options.compatibilityDate,
							compatibilityFlags: options.compatibilityFlags,
							env: publicEnv,
							runtimeMethods: methods,
							providers: Object.keys(dispatchers),
							method,
							entrypointName,
							invocation: args,
						}
						return invokeGraph(graph, dispatchers, undefined, signal)
					}
					return {
						evaluate(
							dispatchers: Record<string, RunnerDispatcher>,
							invocation?: unknown,
							signal?: AbortSignal,
						) {
							return invoke('evaluate', invocation ?? {}, dispatchers, signal)
						},
						async fetch(request: Request) {
							const body = request.body
								? Buffer.from(await request.arrayBuffer()).toString('base64')
								: null
							const result = (await invoke(
								'fetch',
								{
									url: request.url,
									method: request.method,
									headers: [...request.headers],
									redirect: request.redirect,
									body,
								},
								{},
								request.signal,
							)) as {
								status: number
								statusText: string
								headers: Array<[string, string]>
								body: string
							}
							return new Response(
								request.method === 'HEAD' ||
									[204, 205, 304].includes(result.status)
									? null
									: Buffer.from(result.body, 'base64'),
								{
									status: result.status,
									statusText: result.statusText,
									headers: result.headers,
								},
							)
						},
					}
				},
			})
			return {
				invokeGraph,
				load,
				get(_id: string, factory: () => RunnerWorkerOptions) {
					return load(factory())
				},
			}
		},
	}
}
