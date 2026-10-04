import { type FetchGatewayProps } from '#worker/egress/proxy.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { serializeWorkerLoaderModules } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type RunnerGraph } from './supervisor.ts'

export { packageAppRuntimeMethods } from './bridge-methods.ts'

type Dispatcher = { call(name: string, args: string): Promise<string> }
export type RunnerWorkerOptions = {
	mainModule: string
	modules: WorkerLoaderModules
	compatibilityDate: string
	compatibilityFlags: Array<string>
	env?: Record<string, unknown>
	runtimeMethods?: Record<string, Array<string>>
	globalOutbound?: unknown
}
export type RunnerLoader = ReturnType<typeof createRunnerLoader>

/** Trusted host port. prepare runs in an activity; registrations never enter the sandbox graph. */
export function createRunnerLoader(input: {
	putObject(key: string, graph: RunnerGraph): Promise<void>
	prepare(
		context: FetchGatewayProps,
	): Promise<{ runId: string; runToken: string; runtimeSessionId: string }>
	register(run: {
		runId: string
		userId: string
		context: FetchGatewayProps
		dispatch(capability: string, args: unknown): Promise<string>
	}): () => void
	invoke(input: {
		runtimeSessionId: string
		payload: { bundleKey: string; runToken: string; runId: string }
	}): Promise<unknown>
}) {
	return {
		forContext(context: FetchGatewayProps) {
			const load = (options: RunnerWorkerOptions) => ({
				getEntrypoint(entrypointName?: string) {
					async function invoke(
						method: 'evaluate' | 'fetch',
						args: unknown,
						dispatchers: Record<string, Dispatcher> = {},
					) {
						if (!context.userId)
							throw new Error('Runner requires a signed-in owner.')
						const run = await input.prepare(context)
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
						const unregister = input.register({
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
						try {
							const graph: RunnerGraph = {
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
							const bundleKey = `${context.userId}/runner-inputs/${run.runId}.json`
							await input.putObject(bundleKey, graph)
							return await input.invoke({
								runtimeSessionId: run.runtimeSessionId,
								payload: {
									bundleKey,
									runToken: run.runToken,
									runId: run.runId,
								},
							})
						} finally {
							unregister()
						}
					}
					return {
						evaluate(
							dispatchers: Record<string, Dispatcher>,
							invocation?: unknown,
						) {
							return invoke('evaluate', invocation ?? {}, dispatchers)
						},
						async fetch(request: Request) {
							const body = request.body
								? Buffer.from(await request.arrayBuffer()).toString('base64')
								: null
							const result = (await invoke('fetch', {
								url: request.url,
								method: request.method,
								headers: [...request.headers],
								redirect: request.redirect,
								body,
							})) as {
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
				load,
				get(_id: string, factory: () => RunnerWorkerOptions) {
					return load(factory())
				},
			}
		},
	}
}
