import { createServer } from 'node:http'
import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createExecutorModuleSource } from '#mcp/executor.ts'
import { createRuntimeModuleSource } from '#worker/package-runtime/runtime-source-modules.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import {
	createDenoFixtureRunner,
	type RunnerGraph,
} from '#worker/test-support/deno-fixture-runner.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { createPackageAppWorkerSource } from '#worker/package-runtime/package-app.ts'
import { runtimeModulePath } from '#worker/package-runtime/module-graph-paths.ts'
import { compileDenoGraph, invokeDenoSpike } from './deno-spike.ts'
import { createWorker } from './package-build-tools.ts'

function executor(
	code: string,
	modules: RunnerGraph['modules'] = {},
): RunnerGraph {
	return {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule: 'executor.js',
		modules: {
			...modules,
			'executor.js': createExecutorModuleSource({
				code,
				providers: [{ name: 'kody', fns: {} }],
				shadowGlobalThis: false,
				timeoutMs: 2000,
			}),
		},
	}
}

async function endpoints(delayFetchMs = 0) {
	const calls: Array<{
		token: unknown
		body: { capability: string; arguments: unknown }
	}> = []
	const egress: Array<unknown> = []
	const server = createServer(async (request, response) => {
		const chunks: Array<Buffer> = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		if (request.method === 'POST') {
			const body = JSON.parse(Buffer.concat(chunks).toString())
			calls.push({ token: request.headers['x-kody-run-token'], body })
			const result = body.capability.endsWith('listMcpServerNames')
				? []
				: /packageRuntimeRun(Start|Finish)$/.test(body.capability)
					? null
					: (body.arguments.parameters?.[0] ?? 7)
			response.end(JSON.stringify({ result }))
		} else {
			if (delayFetchMs)
				await new Promise((resolve) => setTimeout(resolve, delayFetchMs))
			egress.push({
				token: request.headers['x-kody-run-token'],
				host: request.headers.host,
				path: request.url,
			})
			response.end('proxied')
		}
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address() as { port: number }
	return {
		url: `http://127.0.0.1:${address.port}`,
		calls,
		egress,
		[Symbol.asyncDispose]: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

test('Deno fetch propagates package AbortSignals through the private bridge', async () => {
	await using endpoint = await endpoints(250)
	const result = await invokeDenoSpike({
		graph: executor(`async () => {
			const before = new AbortController(); before.abort(new Error('before-fetch'));
			let first; try { await fetch('https://api.example.com/before', {signal: before.signal}); } catch (error) {first=error.message;}
			const during = new AbortController(); const request = fetch('https://api.example.com/during', {signal: during.signal});
			setTimeout(() => during.abort(new Error('during-fetch')), 10);
			let second; try { await request; } catch (error) {second=error.message;}
			return {first,second};
		}`),
		runToken: 'synthetic',
		brokerUrl: endpoint.url,
		egressUrl: endpoint.url,
	})
	expect(result).toMatchObject({
		result: { first: 'before-fetch', second: 'during-fetch' },
	})
	expect(endpoint.egress).not.toContainEqual(
		expect.objectContaining({ path: '/before' }),
	)
})

test(
	'Deno preserves legacy executor and asynchronous package modules on separate state',
	{ timeout: 60000 },
	async () => {
		let graph = executor(
			`async (input) => {
		await import('kody:runtime');
		const storage = globalThis[Symbol.for('kody.runtimeStorage')];
		const published = await import('published.js');
		const values = await Promise.all([3, 7].map(number => storage.run({kody: __kodyProvider}, async () => published.default({number}))));
		console.log('published:' + input.surface);
		const response = await fetch('https://api.example.com/data');
		return {values, body: await response.text(), surface: input.surface};
	}`,
			{
				'kody:runtime': { js: createRuntimeModuleSource() },
				'published.js': `import {kody} from 'kody:runtime'; import value from './cjs.js'; import json from './json'; import text from './text'; export default async ({number}) => { await new Promise(resolve=>setTimeout(resolve, number)); return {value:await kody.storageSql({sql:'SELECT ?', parameters:[number]}), modules:[value, json.answer, text]} }`,
				'cjs.js': { cjs: 'module.exports = 11' },
				json: { json: { answer: 42 } },
				text: { text: 'captured' },
			},
		)
		await using nativeEndpoint = await endpoints()
		await using denoEndpoint = await endpoints()
		await using native = await createDenoFixtureRunner({
			brokerUrl: nativeEndpoint.url,
			egressUrl: nativeEndpoint.url,
			readObject: async () => graph,
		})
		for (const surface of [
			'mcp',
			'module',
			'job',
			'subscription',
			'retriever',
		]) {
			graph.invocation = { surface }
			const baseline = await native.invoke({
				bundleKey: 'alice/runner-inputs/test.json',
				runToken: 'run-token',
				runId: crypto.randomUUID(),
			})
			const replacement = await invokeDenoSpike({
				graph,
				runToken: 'run-token',
				brokerUrl: denoEndpoint.url,
				egressUrl: denoEndpoint.url,
			})
			expect(replacement).toEqual(baseline)
			expect(replacement).toMatchObject({
				result: {
					values: [{ value: 3, modules: [11, 42, 'captured'] }, { value: 7 }],
					body: 'proxied',
					surface,
				},
				logs: [`published:${surface}`],
			})
		}
		expect(denoEndpoint.calls).toEqual(nativeEndpoint.calls)
		graph = {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'app-wrapper.js',
			entrypointName: 'PackageAppWorker',
			method: 'fetch',
			modules: {
				'app-wrapper.js': createPackageAppWorkerSource({
					mainModule: 'app.js',
				}),
				[runtimeModulePath]: createRuntimeModuleSource(),
				'app.js': `import {kody, packageContext} from './${runtimeModulePath}'; export default async request => new Response(new URL(request.url).pathname + ':' + packageContext.packageId + ':' + await kody.storageSql({sql:'SELECT 7'}), {status:202});`,
			},
			env: {
				__kodyPackageContext: {
					packageId: 'package-notes',
					kodyId: 'notes',
					sourceId: 'source-notes',
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
			invocation: {
				url: 'https://alice.kody.run/notes',
				method: 'GET',
				headers: [],
				body: null,
			},
		}
		const wrappedBaseline = await native.invoke({
			bundleKey: 'alice/runner-inputs/wrapped.json',
			runToken: 'run-token',
			runId: crypto.randomUUID(),
		})
		const wrappedReplacement = await invokeDenoSpike({
			graph,
			runToken: 'run-token',
			brokerUrl: denoEndpoint.url,
			egressUrl: denoEndpoint.url,
		})
		expect(wrappedReplacement).toEqual(wrappedBaseline)
		expect(wrappedReplacement).toMatchObject({
			status: 202,
			body: Buffer.from('/notes:package-notes:7').toString('base64'),
		})
		// Read-only discovery may interleave with the non-blocking run-record start.
		const discovery = (call: (typeof denoEndpoint.calls)[number]) =>
			call.body.capability === 'KODY_RUNTIME.listMcpServerNames'
		expect(denoEndpoint.calls.filter(discovery)).toEqual(
			nativeEndpoint.calls.filter(discovery),
		)
		expect(denoEndpoint.calls.filter((call) => !discovery(call))).toEqual(
			nativeEndpoint.calls.filter((call) => !discovery(call)),
		)
		expect(denoEndpoint.egress).toEqual(nativeEndpoint.egress)
		const binary = executor(
			`async () => [...new Uint8Array((await import('bytes')).default)]`,
			{ bytes: { dataBase64: 'AP8I' } },
		)
		expect(
			await invokeDenoSpike({
				graph: binary,
				runToken: 'run-token',
				brokerUrl: denoEndpoint.url,
				egressUrl: denoEndpoint.url,
			}),
		).toMatchObject({ result: [0, 255, 8] })
	},
)

test(
	'the spike compares computed imports and serialized legacy binary artifacts',
	{ timeout: 30000 },
	async () => {
		await using endpoint = await endpoints()
		let graph = executor(
			`async () => {const name='published.js'; return (await import(name)).default}`,
			{ 'published.js': 'export default 42' },
		)
		await using native = await createDenoFixtureRunner({
			brokerUrl: endpoint.url,
			egressUrl: endpoint.url,
			readObject: async () => graph,
		})
		const invoke = () =>
			invokeDenoSpike({
				graph,
				runToken: 'run-token',
				brokerUrl: endpoint.url,
				egressUrl: endpoint.url,
			})
		expect(
			await native.invoke({
				bundleKey: 'alice/runner-inputs/computed.json',
				runToken: 'run-token',
				runId: crypto.randomUUID(),
			}),
		).toMatchObject({ result: 42 })
		expect(await invoke()).toMatchObject({ result: 42 })
		graph = executor(
			`async () => [...new Uint8Array((await import('bytes')).default)]`,
			{ bytes: { dataBase64: 'AP8I' } },
		)
		const binaryBaseline = await native.invoke({
			bundleKey: 'alice/runner-inputs/binary.json',
			runToken: 'run-token',
			runId: crypto.randomUUID(),
		})
		expect(await invoke()).toEqual(binaryBaseline)
		expect(binaryBaseline).toMatchObject({ result: [0, 255, 8] })
	},
)

test(
	'Deno preserves package HTTP, waitUntil, captured npm and JSX/browser artifacts',
	{ timeout: 60000 },
	async () => {
		await using nativeEndpoint = await endpoints()
		await using denoEndpoint = await endpoints()
		let graph: RunnerGraph
		await using native = await createDenoFixtureRunner({
			brokerUrl: nativeEndpoint.url,
			egressUrl: nativeEndpoint.url,
			readObject: async () => graph,
		})
		const artifact = await native.createWorker({
			entryPoint: 'entry.tsx',
			jsx: 'transform',
			files: {
				'entry.tsx': `import { label } from 'captured'; const React = { createElement: (tag, props, ...children) => ({ tag, children }) }; export default { async fetch(request: Request, env, ctx) { ctx.waitUntil(env.RUNTIME.listMcpServerNames()); const response = await fetch('https://api.example.com/data'); return Response.json({path:new URL(request.url).pathname, value:<span>{label}</span>, body:await response.text()}, {status:201, headers:{'x-fixture':'true'}}) } };`,
				'node_modules/captured/package.json': JSON.stringify({
					name: 'captured',
					version: '1.0.0',
					main: 'index.js',
				}),
				'node_modules/captured/index.js': `exports.label = 'already-published'`,
			},
		})
		graph = {
			...createDynamicWorkerCompatibilityOptions(),
			...artifact,
			method: 'fetch',
			runtimeMethods: { RUNTIME: ['listMcpServerNames'] },
			invocation: {
				url: 'https://alice.kody.run/example',
				method: 'GET',
				headers: [],
				body: null,
			},
		}
		const baseline = await native.invoke({
			bundleKey: 'alice/runner-inputs/http.json',
			runToken: 'run-token',
			runId: crypto.randomUUID(),
		})
		const replacement = await invokeDenoSpike({
			graph,
			runToken: 'run-token',
			brokerUrl: denoEndpoint.url,
			egressUrl: denoEndpoint.url,
		})
		expect(replacement).toEqual(baseline)
		expect(replacement).toMatchObject({
			status: 201,
			headers: expect.arrayContaining([['x-fixture', 'true']]),
		})
		expect(denoEndpoint.calls).toEqual(nativeEndpoint.calls)
		const client = await native.createWorker({
			entryPoint: 'client.tsx',
			jsx: 'transform',
			files: {
				'client.tsx': `const React={createElement:(tag,props,...children)=>({tag,children})}; export default <span>browser</span>`,
			},
		})
		const clientGraph = executor(
			`async () => ({value:(await import(${JSON.stringify(client.mainModule)})).default, clone:Response.json({ok:true}).clone() instanceof Response, empty:new Response(null,{status:201,statusText:''}).statusText})`,
			client.modules,
		)
		graph = clientGraph
		expect(
			await invokeDenoSpike({
				graph,
				runToken: 'run-token',
				brokerUrl: denoEndpoint.url,
				egressUrl: denoEndpoint.url,
			}),
		).toEqual(
			await native.invoke({
				bundleKey: 'alice/runner-inputs/client.json',
				runToken: 'run-token',
				runId: crypto.randomUUID(),
			}),
		)
	},
)

test(
	'Deno fails closed on static escapes and bounds runtime access, loops, output and cancellation',
	{ timeout: 60000 },
	async () => {
		await using endpoint = await endpoints()
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), 'kody-deno-lifecycle-tests-'),
		)
		await using cleanup = new AsyncDisposableStack()
		cleanup.defer(() => rm(temporaryRoot, { recursive: true, force: true }))
		const ownedDirectories = async () =>
			(await readdir(temporaryRoot))
				.filter((name) => name.startsWith('kody-deno-run-'))
				.sort()
		const initialDirectories = await ownedDirectories()
		const invoke = (
			graph: RunnerGraph,
			options: { timeoutMs?: number; signal?: AbortSignal } = {},
		) =>
			invokeDenoSpike({
				graph,
				runToken: 'host-secret-token',
				brokerUrl: endpoint.url,
				egressUrl: endpoint.url,
				...options,
				temporaryRoot,
			})
		for (const specifier of [
			'file:///etc/passwd',
			'/etc/passwd',
			'https://example.com/mod.js',
			'npm:evil',
			'jsr:evil',
			'node:fs',
			'node:child_process',
		]) {
			await expect(
				compileDenoGraph({
					...executor('async () => 1'),
					mainModule: 'escape.js',
					modules: {
						'escape.js': `import '${specifier}'; export default {evaluate(){return 1}}`,
					},
				}),
			).rejects.toThrow(/Unauthorized module|outside the authorized graph/)
		}
		const denied = await invoke(
			executor(`async () => {
		const attempts = [() => Deno.readTextFile('/etc/passwd'), () => Deno.env.get('AWS_SECRET_ACCESS_KEY'), () => Deno.connect({hostname:'127.0.0.1',port:80}), () => new Deno.Command('sh').spawn(), () => Deno.dlopen('/tmp/no.so', {}), () => Deno.hostname(), () => {const path='file:///etc/passwd'; return import(path)}, () => {const url='https://169.254.169.254/latest/meta-data'; return new WebSocket(url.replace('http','ws'))}, () => new Worker('data:application/javascript,import "file:///etc/passwd"', {type:'module'})];
		return await Promise.all(attempts.map(async attempt => {try {await attempt();return 'allowed'} catch {return 'denied'}}));
	}`),
		)
		expect(denied).toMatchObject({ result: Array(9).fill('denied') })
		const clean = executor(
			`async () => { const old=globalThis.previous; globalThis.previous=1; return {fresh:old===undefined,token:typeof hostSecretToken}; }`,
		)
		for (let i = 0; i < 2; i++)
			expect(await invoke(clean)).toMatchObject({
				result: { fresh: true, token: 'undefined' },
			})
		await expect(
			invoke(
				executor(
					`async () => { await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({type:'bridge',id:1,kind:'capability',capability:'admin',arguments:{owner:'bob'}})+'\\n')); return 1; }`,
				),
			),
		).rejects.toThrow('Unauthenticated sandbox frame')
		await expect(
			invoke(executor('async () => {while(true){}}'), { timeoutMs: 300 }),
		).rejects.toThrow('deadline')
		await expect(
			invoke(executor(`async () => 'x'.repeat(200000)`)),
		).rejects.toThrow('limit')
		const large = (await invoke({
			...executor(`async () => 'x'.repeat(200000)`),
			bodyLimitBytes: 16 * 1024 * 1024,
			responseLimitBytes: 16 * 1024 * 1024,
		})) as { result: string }
		expect(large.result).toHaveLength(200000)
		const cancelled = new AbortController()
		cancelled.abort(new Error('Cancelled before preparation'))
		await expect(
			invoke(executor('async () => 1'), { signal: cancelled.signal }),
		).rejects.toThrow('Cancelled before preparation')
		await expect(
			invoke(executor('async () => new Promise(() => {})'), {
				signal: AbortSignal.timeout(300),
			}),
		).rejects.toThrow('cancelled')
		const httpGraph = (code: string): RunnerGraph => ({
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'app.js',
			method: 'fetch',
			modules: {
				'app.js': `export default { async fetch(request, env, ctx) { ${code} } }`,
			},
			invocation: {
				url: 'https://alice.kody.run/test',
				method: 'GET',
				headers: [],
				body: null,
			},
		})
		await expect(
			invoke(
				httpGraph(
					`ctx.waitUntil(Promise.reject(new Error('background failure'))); return new Response('ok');`,
				),
			),
		).rejects.toThrow('background failure')
		await expect(
			invoke(
				httpGraph(
					`Promise.reject(new Error('unhandled failure')); return new Response('ok');`,
				),
			),
		).rejects.toThrow('unhandled failure')
		await expect(
			invoke(
				httpGraph(
					`return new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(65536));}}));`,
				),
			),
		).rejects.toThrow('response limit')
		await expect(
			invoke(executor(`async () => {Deno.exit(27)}`), { timeoutMs: 500 }),
		).rejects.toThrow(/exited|deadline/)
		expect(await ownedDirectories()).toEqual(initialDirectories)
		expect(endpoint.calls).toEqual([])
	},
)

test(
	'standalone Temporal ExecuteRun activity builds with esbuild and executes the Deno graph once',
	{ timeout: 60000 },
	async () => {
		await using endpoint = await endpoints()
		const temporal = await createTemporalEnv()
		let executions = 0
		try {
			await temporal.startWorkers({
				queues: ['runtime'],
				activities: {
					async consumeMeter() {},
					async executeCode(input) {
						executions++
						const artifact = await createWorker({
							entryPoint: 'entry.ts',
							files: {
								'entry.ts': `export default async () => {${input.code}}`,
							},
						})
						const result = (await invokeDenoSpike({
							graph: executor(
								`async () => (await import('${artifact.mainModule}')).default()`,
								artifact.modules,
							),
							runToken: 'synthetic-token',
							brokerUrl: endpoint.url,
							egressUrl: endpoint.url,
						})) as { result: unknown }
						return {
							runId: input.runId,
							ok: true,
							output: JSON.stringify(result.result),
						}
					},
				},
			})
			const result = await temporal.client.workflow.execute('ExecuteRun', {
				workflowId: 'alice:execute:deno-spike',
				taskQueue: 'runtime',
				args: [
					{ userId: 'alice', requestId: 'deno-spike', code: 'return 6 * 7' },
				],
			})
			expect(result).toMatchObject({
				ok: true,
				output: '42',
				runId: expect.any(String),
			})
			expect(executions).toBe(1)
		} finally {
			await temporal.close()
		}
	},
)
