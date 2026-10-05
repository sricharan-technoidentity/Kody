import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import { createRuntimeModuleSource } from '#worker/package-runtime/runtime-source-modules.ts'
import { createExecutorModuleSource } from '#mcp/executor.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { createDenoFixtureRunner } from '../test-support/deno-fixture-runner.ts'

test('real Deno runs unchanged module sources, brokers capabilities and proxies fetch', async () => {
	const calls: Array<{ token: string; body: unknown }> = []
	const egress: Array<string> = []
	const endpoint = createServer(async (request, response) => {
		const chunks: Array<Buffer> = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		if (request.method === 'POST') {
			calls.push({
				token: String(request.headers['x-kody-run-token']),
				body: JSON.parse(Buffer.concat(chunks).toString()),
			})
			response.end(JSON.stringify({ result: 7 }))
		} else {
			egress.push(String(request.headers['x-kody-run-token']))
			response.end('proxied')
		}
	})
	await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
	const address = endpoint.address() as { port: number }
	const code =
		'async () => { await import("kody:runtime"); const value = await globalThis[Symbol.for("kody.runtimeStorage")].run({ kody: __kodyProvider }, async () => (await import("published.js")).default()); const response = await fetch("https://api.example.com/data"); return { value, body: await response.text(), hasEnv: typeof process === "undefined" || !process.env.AWS_SECRET_ACCESS_KEY }; }'
	const graph = {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule: 'executor.js',
		modules: {
			'executor.js': createExecutorModuleSource({
				code,
				providers: [{ name: 'kody', fns: {} }],
				shadowGlobalThis: false,
				timeoutMs: 2000,
			}),
			'kody:runtime': { js: createRuntimeModuleSource() },
			'published.js':
				'import { kody } from "kody:runtime"; export default async function () { return kody.storageSql({sql:"SELECT 7"}); }',
		},
	}
	await using runner = await createDenoFixtureRunner({
		brokerUrl: `http://127.0.0.1:${address.port}/broker`,
		egressUrl: `http://127.0.0.1:${address.port}/egress`,
		readObject: async () => graph,
	})
	try {
		const response = await runner.invoke({
			bundleKey: 'alice/bundle.json',
			runToken: 'signed-run',
			runId: 'run-1',
		})
		expect(response).toMatchObject({
			result: { value: 7, body: 'proxied', hasEnv: true },
		})
		expect(calls).toEqual([
			{
				token: 'signed-run',
				body: { capability: 'storageSql', arguments: { sql: 'SELECT 7' } },
			},
		])
		expect(egress).toEqual(['signed-run'])
	} finally {
		await new Promise<void>((resolve) => endpoint.close(() => resolve()))
	}
})

import { createRunnerLoader } from './loader.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { mintRunToken } from './run-token.ts'
import {
	buildKodyAppBundle,
	buildKodyModuleBundle,
	hydrateKodyRuntimeModules,
} from '#worker/package-runtime/module-graph.ts'
import { createPackageAppWorkerSource } from '#worker/package-runtime/package-app.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

test(
	'published package bundler output runs unchanged through an S3 graph ref and authenticated broker',
	{ timeout: 30000 },
	async () => {
		const signingKey = 'test-signing-key-000000000000000000'
		const broker = createBrokerHandler({ signingKey })
		const appEgress: Array<{ token: string; authorization: string }> = []
		const endpoint = createServer(async (request, response) => {
			if (request.headers.host === 'api.example.com') {
				appEgress.push({
					token: String(request.headers['x-kody-run-token']),
					authorization: String(request.headers.authorization),
				})
				response.writeHead(appEgress.length === 1 ? 401 : 200)
				response.end('proxied-auth')
				return
			}
			const chunks: Array<Buffer> = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			const headers = new Headers()
			for (const [name, value] of Object.entries(request.headers))
				if (value)
					headers.set(name, Array.isArray(value) ? value.join(',') : value)
			const result = await broker.fetch(
				new Request('https://broker.internal/', {
					method: request.method,
					headers,
					body: Buffer.concat(chunks),
				}),
			)
			response.writeHead(result.status, Object.fromEntries(result.headers))
			response.end(Buffer.from(await result.arrayBuffer()))
		})
		await new Promise<void>((resolve) =>
			endpoint.listen(0, '127.0.0.1', resolve),
		)
		try {
			const address = endpoint.address() as { port: number }
			const objects = new Map<
				string,
				import('../test-support/deno-fixture-runner.ts').RunnerGraph
			>()
			await using runner = await createDenoFixtureRunner({
				brokerUrl: `http://127.0.0.1:${address.port}`,
				egressUrl: `http://127.0.0.1:${address.port}`,
				async readObject(key) {
					const graph = objects.get(key)
					if (!graph) throw new Error('Missing S3 graph.')
					return graph
				},
			})
			await using database = await createTestDb({ userId: 'alice' })
			const env = {
				APP_DB: database.db,
				RUNNER_BUNDLER: runner,
			} as unknown as Env
			const bundle = await buildKodyModuleBundle({
				env,
				userId: 'alice',
				baseUrl: 'https://kody.dev',
				rootPackageId: 'package-notes',
				entryPoint: 'entry.ts',
				sourceFiles: {
					'entry.ts': `import { kody } from 'kody:runtime'; export default async (input: {number: number}) => {console.log('published');return await kody.storageSql({sql:'SELECT ?', parameters:[input.number]})}`,
				},
			})
			const hydrated = await hydrateKodyRuntimeModules({
				env,
				userId: 'alice',
				baseUrl: 'https://kody.dev',
				modules: bundle.modules,
			})
			const refInvocations: Array<unknown> = []
			const loader = createRunnerLoader({
				async putObject(key, graph) {
					objects.set(key, graph)
				},
				async prepare(context) {
					const runId = crypto.randomUUID()
					return {
						runId,
						runtimeSessionId: '0'.repeat(64),
						runToken: await mintRunToken(signingKey, {
							userId: 'alice',
							runId,
							expiresAt: Date.now() + 10000,
							retriever: context.allowOutboundFetch === false,
							provenance: [
								{
									moduleId: bundle.mainModule,
									packageId: 'package-notes',
									storageId: 'package:package-notes',
								},
							],
						}),
					}
				},
				register: broker.register,
				async invoke(input) {
					refInvocations.push(input)
					return runner.invoke(input.payload)
				},
			})
			const graph = {
				...createDynamicWorkerCompatibilityOptions(),
				mainModule: 'executor.js',
				modules: {
					...hydrated.modules,
					'executor.js': createExecutorModuleSource({
						code: `async (__invocation) => {const {AsyncLocalStorage}=await import('node:async_hooks');const symbol=Symbol.for('kody.runtimeStorage');globalThis[symbol]??=new AsyncLocalStorage();return globalThis[symbol].run({kody:__kodyProvider},async () => (await import(${JSON.stringify('./' + bundle.mainModule)})).default(__invocation.params));}`,
						providers: [{ name: 'kody', fns: {} }],
						shadowGlobalThis: false,
						timeoutMs: 2000,
					}),
				},
			}
			const dispatched: Array<unknown> = []
			const result = await loader
				.forContext({
					baseUrl: 'https://kody.dev',
					userId: 'alice',
					email: null,
					storageContext: {
						sessionId: null,
						appId: null,
						packageId: 'package-notes',
						storageId: null,
					},
				})
				.load(graph)
				.getEntrypoint()
				.evaluate(
					{
						kody: {
							async call(name, json) {
								dispatched.push({ name, args: JSON.parse(json) })
								return JSON.stringify({ result: 9 })
							},
						},
					},
					{ params: { number: 9 } },
				)
			expect(result).toMatchObject({ result: 9, logs: ['published'] })
			expect(dispatched).toEqual([
				{ name: 'storageSql', args: { sql: 'SELECT ?', parameters: [9] } },
			])
			expect(refInvocations).toEqual([
				expect.objectContaining({
					payload: {
						bundleKey: expect.stringMatching(/^alice\/runner-inputs\//),
						runId: expect.any(String),
						runToken: expect.any(String),
					},
				}),
			])
			expect(JSON.stringify(refInvocations)).not.toContain('console.log')
			// The authored app uses the existing wrapper and runtime bridge API unchanged.
			const appBundle = await buildKodyAppBundle({
				env,
				userId: 'alice',
				baseUrl: 'https://kody.dev',
				entryPoint: 'app.ts',
				sourceFiles: {
					'app.ts': `import {kody, createAuthenticatedFetch} from 'kody:runtime'; export default async (request: Request) => { const authenticatedFetch = await createAuthenticatedFetch('example'); const response = await authenticatedFetch('/data'); return new Response(new URL(request.url).pathname + ':' + await kody.storageSql({sql:'SELECT 11'}) + ':' + await response.text(), {status:201,headers:{'x-published':'true'}}) }`,
				},
			})
			const appHydrated = await hydrateKodyRuntimeModules({
				env,
				userId: 'alice',
				baseUrl: 'https://kody.dev',
				modules: appBundle.modules,
			})
			const integrationCalls: Array<string> = []
			class Bridge {
				async packageRuntimeRunStart() {
					return null
				}
				async packageRuntimeRunFinish() {
					return null
				}
				async listMcpServerNames() {
					return []
				}
				async callCapability(input: { name: string; args: unknown }) {
					if (input.name.startsWith('integration')) {
						integrationCalls.push(input.name)
						return input.name === 'integrationGet'
							? {
									integration: {
										name: 'example',
										apiBaseUrl: 'https://api.example.com',
									},
								}
							: { ok: true }
					}
					expect(input).toEqual({
						name: 'storageSql',
						args: { sql: 'SELECT 11' },
					})
					return 11
				}
			}
			const appResponse = await loader
				.forContext({
					baseUrl: 'https://kody.dev',
					userId: 'alice',
					email: null,
					storageContext: {
						sessionId: null,
						appId: 'package-notes',
						packageId: 'package-notes',
						storageId: null,
					},
				})
				.load({
					...createDynamicWorkerCompatibilityOptions(),
					mainModule: 'package-app-entry.js',
					modules: {
						...appHydrated.modules,
						'package-app-entry.js': createPackageAppWorkerSource({
							mainModule: appBundle.mainModule,
						}),
					},
					env: {
						KODY_RUNTIME: new Bridge(),
						__kodyPackageContext: {
							packageId: 'package-notes',
							kodyId: 'notes',
							sourceId: 'source-notes',
							appBasePath: '/notes',
						},
					},
					runtimeMethods: {
						KODY_RUNTIME: [
							'packageRuntimeRunStart',
							'packageRuntimeRunFinish',
							'listMcpServerNames',
							'callCapability',
						],
					},
				})
				.getEntrypoint('PackageAppWorker')
				.fetch(
					new Request('https://alice.kody.run/notes', {
						method: 'POST',
						body: 'original',
					}),
				)
			expect(appResponse.status).toBe(201)
			expect(appResponse.headers.get('x-published')).toBe('true')
			expect(await appResponse.text()).toBe('/notes:11:proxied-auth')
			expect(integrationCalls).toEqual([
				'integrationGet',
				'integrationTokenRefresh',
			])
			expect(appEgress).toEqual([
				expect.objectContaining({
					token: expect.any(String),
					authorization: 'Bearer {{integration-token:example}}',
				}),
				expect.objectContaining({
					token: expect.any(String),
					authorization: 'Bearer {{integration-token:example}}',
				}),
			])
			expect(appEgress[0]!.token).toBe(appEgress[1]!.token)
		} finally {
			await new Promise<void>((resolve) => endpoint.close(() => resolve()))
		}
	},
)
