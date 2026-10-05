import { expect, test } from 'vitest'
import { createExecutorModuleSource } from '#mcp/executor.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { createEgressHandler } from '#worker/egress/egress-proxy.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createRunnerLoader } from '#worker/runner/loader.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { runnerSessionId } from '#worker/aws/agentcore-runner.ts'
import { createTargetActivities } from '#worker/temporal/activities/target.ts'
import { executeRun } from '#worker/temporal/execute-run.ts'
import { createTargetTestEnv } from '#worker/test-support/aws/target-test-env.ts'
import { createRunnerTestEnv } from '#worker/test-support/runner.ts'
import { startRunnerHost } from './runner-host.ts'
import { invokeDenoSpike } from './deno-spike.ts'

test(
	'shared direct/activity preparation survives a safe retry, but never repeats uncertain dispatch',
	{ timeout: 120000 },
	async () => {
		const target = await createTargetTestEnv({ userId: 'alice' })
		const { env } = target
		const stack = new AsyncDisposableStack()
		stack.defer(target.close)
		try {
			let broker = createBrokerHandler({
				signingKey: env.RUN_TOKEN_SIGNING_KEY,
			})
			const egress = createEgressHandler({
				signingKey: env.RUN_TOKEN_SIGNING_KEY,
				forUser: () => env,
				connect: async () => {
					throw new Error('Unexpected outbound connection')
				},
			})
			const brokerServer = stack.use(
				await startFrontDoorServer({
					fetch: (request) => broker.fetch(request),
				}),
			)
			const egressServer = stack.use(
				await startFrontDoorServer({ fetch: egress.fetch }),
			)
			let reads = 0
			let executions = 0
			let effects = 0
			let registrations = 0
			const host = await startRunnerHost({
				port: 0,
				host: '127.0.0.1',
				allowLocalHttp: true,
				brokerUrl: brokerServer.origin,
				egressUrl: egressServer.origin,
				async readObject(key) {
					reads++
					const bytes = env.objects.get(key)
					if (!bytes) throw new Error('Missing graph')
					return JSON.parse(new TextDecoder().decode(bytes)) as RunnerGraph
				},
				async execute(graph, invocation) {
					executions++
					return invokeDenoSpike({
						graph,
						runToken: invocation.runToken,
						brokerUrl: brokerServer.origin,
						egressUrl: egressServer.origin,
					})
				},
			})
			stack.defer(host.close)
			const stored: Array<string> = []
			const tokens: Array<string> = []
			let failStore = false
			let loseResponse = false
			let restartBroker = false
			const failedPreparation = Promise.withResolvers<void>()
			const loader = createRunnerLoader({
				idempotency: env.TEMPORAL.idempotency,
				async prepare(context, logicalRunId) {
					const runId = logicalRunId ?? crypto.randomUUID()
					const runToken = await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
						userId: context.userId!,
						runId,
						expiresAt: Date.now() + 90000,
						retriever: context.allowOutboundFetch === false,
						provenance: [
							{
								moduleId: 'entry',
								packageId: null,
								storageId: `exec:${runId}`,
							},
						],
					})
					tokens.push(runToken)
					return {
						runId,
						runToken,
						runtimeSessionId: runnerSessionId(context.userId!, runId),
					}
				},
				register(run) {
					const unbroker = broker.register(run)
					let unegress: () => void
					try {
						unegress = egress.register(run)
					} catch (error) {
						unbroker()
						throw error
					}
					registrations++
					return () => {
						unbroker()
						unegress()
						registrations--
					}
				},
				async putObject(key, graph) {
					stored.push(key)
					if (failStore) {
						failStore = false
						failedPreparation.resolve()
						throw new Error('Synthetic S3 outage before dispatch')
					}
					env.objects.put(key, new TextEncoder().encode(JSON.stringify(graph)))
				},
				async invoke({ payload }) {
					if (restartBroker) {
						restartBroker = false
						broker = createBrokerHandler({
							signingKey: env.RUN_TOKEN_SIGNING_KEY,
						})
					}
					const response = await fetch(`${host.origin}/invocations`, {
						method: 'POST',
						body: JSON.stringify(payload),
					})
					if (!response.ok) throw new Error(await response.text())
					const value: unknown = await response.json()
					if (loseResponse) {
						loseResponse = false
						throw new Error('Synthetic connection loss after effects')
					}
					return value
				},
			})
			const context = {
				userId: 'alice',
				email: null,
				storageContext: null,
				baseUrl: 'https://kody.dev',
			}
			const dispatchers = {
				audit: {
					async call(name: string) {
						if (name !== 'record') throw new Error('Unknown capability')
						effects++
						return JSON.stringify({ result: 42 })
					},
				},
			}
			const graph = (code: string): RunnerGraph => ({
				...createDynamicWorkerCompatibilityOptions(),
				mainModule: 'entry',
				method: 'evaluate',
				providers: ['audit'],
				runtimeMethods: {},
				invocation: {},
				modules: {
					entry: createExecutorModuleSource({
						code,
						providers: [{ name: 'audit', fns: {} }],
						shadowGlobalThis: true,
						timeoutMs: 2000,
					}),
				},
			})
			target.setActivities(
				createTargetActivities(env, {
					runner: {
						loader,
						async resolve(input) {
							return {
								context: { ...context, userId: input.userId },
								graph: graph(
									typeof input.payload.code === 'string'
										? input.payload.code
										: 'async () => audit.record({})',
								),
								dispatchers,
							}
						},
					},
				}),
			)
			const direct = await loader
				.forContext(context)
				.invokeGraph(
					graph('async () => audit.record({})'),
					dispatchers,
					'direct',
				)
			expect(direct).toMatchObject({ result: 42 })
			expect(effects).toBe(1)
			const http = await loader
				.forContext(context)
				.load({
					...createDynamicWorkerCompatibilityOptions(),
					mainModule: 'http.js',
					modules: {
						'http.js': `export default {fetch(){return new Response('hello',{status:201,headers:{'x-test':'shared'}})}}`,
					},
				})
				.getEntrypoint()
				.fetch(new Request('https://app.example.com/'))
			expect(http.status).toBe(201)
			expect(http.headers.get('x-test')).toBe('shared')
			expect(await http.text()).toBe('hello')
			env.kv.put({
				pk: 'alice:meters',
				sk: 'execute_calls_per_day',
				remaining: 1,
			})
			const input = {
				env,
				userId: 'alice',
				requestId: 'shared-deno',
				code: 'async () => audit.record({})',
			}
			const first = await executeRun(input)
			await target.restartWorkers()
			expect(await executeRun(input)).toEqual(first)
			expect(first.result).toBe('42')
			expect(effects).toBe(2)
			const client = await env.TEMPORAL.client('runtime')
			const packageInput = {
				userId: 'alice',
				surface: 'webhook',
				invocationKey: 'safe-retry',
				packageId: 'synthetic',
				exportName: null,
				params: {},
			}
			const start = stored.length
			failStore = true
			const retry = await client.workflow.start('PackageInvocation', {
				workflowId: 'alice:webhook:safe-retry',
				taskQueue: 'runtime',
				args: [packageInput],
			})
			await failedPreparation.promise
			await target.restartWorkers()
			expect(await retry.result()).toMatchObject({ ok: true, output: '42' })
			expect(stored.slice(start)).toHaveLength(2)
			expect(stored[start]).toBe(stored[start + 1])
			expect(effects).toBe(3)
			loseResponse = true
			const uncertain = await client.workflow.execute('PackageInvocation', {
				workflowId: 'alice:webhook:uncertain',
				taskQueue: 'runtime',
				args: [{ ...packageInput, invocationKey: 'uncertain' }],
			})
			expect(uncertain).toMatchObject({
				ok: false,
				error: expect.stringContaining('execution may have completed'),
			})
			expect(effects).toBe(4)
			expect(env.kv.get('alice:runs', uncertain.runId)).toMatchObject({
				status: 'error',
			})
			await target.restartWorkers()
			const beforeReplay = reads
			const replay = await client.workflow.execute('PackageInvocation', {
				workflowId: 'alice:webhook:uncertain-replayed',
				taskQueue: 'runtime',
				args: [{ ...packageInput, invocationKey: 'uncertain' }],
			})
			expect(replay).toMatchObject({
				ok: false,
				error: expect.stringContaining('automatic replay is denied'),
			})
			expect(effects).toBe(4)
			expect(reads).toBe(beforeReplay)
			const beforeRestart = reads
			restartBroker = true
			const restarted = await client.workflow.execute('PackageInvocation', {
				workflowId: 'alice:webhook:broker-restart',
				taskQueue: 'runtime',
				args: [{ ...packageInput, invocationKey: 'broker-restart' }],
			})
			expect(restarted).toMatchObject({
				ok: false,
				error: expect.stringContaining('registration unavailable'),
			})
			expect(reads).toBe(beforeRestart)
			expect(effects).toBe(4)
			expect(executions).toBe(5)
			expect(registrations).toBe(0)
			for (const token of tokens) {
				const authorization = await broker.fetch(
					new Request('https://broker.internal/authorize', {
						method: 'POST',
						headers: { 'x-kody-run-token': token },
					}),
				)
				expect(authorization.status).toBe(401)
			}
		} finally {
			await stack.disposeAsync()
		}
	},
)

test('retained compatibility harness executes an owner-scoped Deno graph', async () => {
	const harness = await createRunnerTestEnv({ backend: 'deno' })
	try {
		const result = await harness.env
			.RUNNER_LOADER!.forContext({
				userId: 'alice',
				baseUrl: 'https://kody.example',
				email: null,
				storageContext: null,
			})
			.load({
				mainModule: 'entry.js',
				modules: {
					'entry.js': `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class Entry extends WorkerEntrypoint {evaluate(){return Deno.version.deno}}`,
				},
				compatibilityDate: '2026-04-16',
				compatibilityFlags: [],
			})
			.getEntrypoint()
			.evaluate({}, {})
		expect(result).toBe('2.9.7')
	} finally {
		await harness.close()
	}
}, 60000)
