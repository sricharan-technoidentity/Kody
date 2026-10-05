import { createServer } from 'node:http'
import { expect, test, vi } from 'vitest'
import {
	createWorker,
	createFileSystemSnapshot,
	createTypescriptLanguageService,
	createCompilationCacheKey,
} from './package-build-tools.ts'
import { invokeDenoSpike } from './deno-spike.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { createExecutorModuleSource } from '#mcp/executor.ts'
import {
	createDenoFixtureRunner,
	type RunnerGraph,
} from '#worker/test-support/deno-fixture-runner.ts'
import {
	buildKodyAppBundle,
	buildKodyModuleBundle,
} from '#worker/package-runtime/module-graph-bundle-builders.ts'
import { buildKodyAppClientBundle } from '#worker/package-runtime/module-graph-client-bundle.ts'
import { hydrateKodyRuntimeModules } from '#worker/package-runtime/module-graph-hydration.ts'
import { createPackageAppWorkerSource } from '#worker/package-runtime/package-app.ts'
import { createRemixPackageAppFiles } from '#worker/test-support/remix-package-app-fixture.ts'
import { collectLiteralImportSpecifiers } from '#worker/package-runtime/import-specifiers.ts'

// Exercise the existing publish checker against replacement tools without switching the app.
vi.mock('#worker/package-build-modules.ts', () => ({
	importPackageBuildTools: () => import('./package-build-tools.ts'),
	importPackageTypescript: () => import('./package-build-tools.ts'),
}))

async function bridge() {
	const calls: Array<{
		capability: string
		arguments: Array<Record<string, unknown>>
	}> = []
	const values = new Map<string, unknown>()
	const server = createServer(async (request, response) => {
		const chunks = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		const call = JSON.parse(Buffer.concat(chunks).toString())
		calls.push(call)
		const args = call.arguments[0]
		const key = args ? `${args.storageId}:${args.key}` : ''
		let result: unknown = null
		if (call.capability.endsWith('listMcpServerNames')) result = []
		if (call.capability.endsWith('storageSet')) values.set(key, args!.value)
		if (
			call.capability.endsWith('storageGet') ||
			call.capability.endsWith('packageStorageGet')
		)
			result = { value: values.get(key) ?? null }
		response.end(JSON.stringify({ result }))
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	return {
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		calls,
		[Symbol.asyncDispose]: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

test('esbuild builds prepared TS/JSX, conditional npm exports, CJS and data without host resolution', async () => {
	const artifact = await createWorker({
		entryPoint: 'entry.tsx',
		jsx: 'transform',
		loader: { '.bin': 'binary' },
		files: {
			'entry.tsx': `import answer from 'captured/answer'; import text from './text.txt'; import bytes from './bytes.bin'; const React = {createElement: (tag, props, ...children) => ({tag, children})}; export default {answer, text, bytes:[...bytes], node:<span>{answer}</span>};`,
			'text.txt': 'prepared',
			'bytes.bin': 'abc',
			'node_modules/captured/package.json': JSON.stringify({
				name: 'captured',
				exports: {
					'./answer': { worker: './worker.cjs', default: './wrong.js' },
				},
			}),
			'node_modules/captured/worker.cjs': 'module.exports = 42',
			'node_modules/captured/wrong.js': 'export default 0',
		},
	})
	const module = await import(
		`data:text/javascript;base64,${Buffer.from(artifact.modules[artifact.mainModule]!).toString('base64')}`
	)
	expect(module.default).toEqual({
		answer: 42,
		text: 'prepared',
		bytes: [97, 98, 99],
		node: { tag: 'span', children: [42] },
	})
	for (const path of [
		'file:///etc/passwd',
		'/etc/passwd',
		'../escape.js',
		'https://example.com/mod.js',
		'npm:captured',
		'typescript',
	]) {
		await expect(
			createWorker({
				files: { 'entry.js': `import '${path}';` },
				entryPoint: 'entry.js',
			}),
		).rejects.toThrow(
			/Invalid prepared file path|escapes prepared workspace|outside prepared files/,
		)
	}
	await expect(
		createWorker({
			files: { '../entry.js': 'export default 1' },
			entryPoint: '../entry.js',
		}),
	).rejects.toThrow('escapes')
	const input = {
		files: { 'entry.ts': 'export default 42' },
		entryPoint: 'entry.ts',
	}
	expect(createCompilationCacheKey('deno-2.9.7', input)).not.toBe(
		createCompilationCacheKey('workerd', input),
	)
})

test('Map-backed TypeScript checks declarations, JSONC extends and synchronized edits without host files', async () => {
	const fileSystem = await createFileSystemSnapshot(
		Object.entries({
			'tsconfig.json':
				'{"extends":"./base.json", "compilerOptions":{"declaration":true, "emitDeclarationOnly":true,},}',
			'base.json':
				'{"compilerOptions":{"target":"es2022","module":"esnext","moduleResolution":"bundler","strict":true}}',
			'entry.ts': `import {value} from './value'; export default function run(): number { return value; }`,
			'value.ts': `export const value = 'wrong';`,
		}),
	)
	const checker = await createTypescriptLanguageService({ fileSystem })
	try {
		expect(
			checker.languageService
				.getSemanticDiagnostics('entry.ts')
				.map((diagnostic) => diagnostic.code),
		).toContain(2322)
		checker.fileSystem.write('value.ts', 'export const value = 42;')
		expect(checker.languageService.getSemanticDiagnostics('entry.ts')).toEqual(
			[],
		)
		expect(
			checker.languageService.getEmitOutput('entry.ts', true).outputFiles,
		).toMatchObject([
			{
				name: '/entry.d.ts',
				text: expect.stringContaining('function run(): number'),
			},
		])
		checker.fileSystem.delete('value.ts')
		expect(
			checker.languageService
				.getSemanticDiagnostics('entry.ts')
				.map((diagnostic) => diagnostic.code),
		).toContain(2307)
		checker.fileSystem.write(
			'entry.ts',
			`import ts from '${process.cwd()}/node_modules/typescript/lib/typescript'; export default ts;`,
		)
		expect(
			checker.languageService
				.getSemanticDiagnostics('entry.ts')
				.map((diagnostic) => diagnostic.code),
		).toContain(2307)
	} finally {
		checker.languageService.dispose()
	}
	const {
		typecheckPackageEntrypointsFromSourceFiles,
		runPackageTypecheckLanguageService,
	} = await import('#worker/repo/checks.ts')
	const run = (source: string) =>
		typecheckPackageEntrypointsFromSourceFiles({
			sourceFiles: { 'entry.ts': source },
			entryPoints: [{ path: 'entry.ts' }],
		})
	expect(await run('export default async () => 42')).toMatchObject({ ok: true })
	expect(await run('export default 42')).toMatchObject({ ok: false })
	expect(
		await runPackageTypecheckLanguageService({
			sourceFiles: {
				'tsconfig.json': '{"compilerOptions":{"strict":true}}',
				'entry.ts': `export default async function run(): Promise<number> { return 'wrong'; }`,
			},
			targets: [{ path: 'entry.ts', kind: 'callable', emittedEventTopics: [] }],
		}),
	).toMatchObject({ ok: false })
})

test(
	'existing package preparation and hydration execute replacement bundles with DurableObject storage and browser rules',
	{ timeout: 60000 },
	async () => {
		await using database = await createTestDb({ userId: 'alice' })
		await using nativeBridge = await bridge()
		await using denoBridge = await bridge()
		const env = { APP_DB: database.db, RUNNER_BUNDLER: { createWorker } } as Env
		const input = {
			env,
			userId: 'alice',
			baseUrl: 'https://kody.example',
			entryPoint: 'app.ts',
		}
		const sourceFiles = {
			'package.json': JSON.stringify({
				name: '@alice/counter',
				exports: { '.': './app.ts' },
				kody: {
					id: 'counter',
					description: 'Counter',
					app: {
						entry: 'app.ts',
						client: {
							entry: 'client.tsx',
							externals: ['preact'],
						},
					},
				},
			}),
			'app.ts': `import {DurableObject} from 'cloudflare:workers'; export class Counter extends DurableObject { async fetch() {const value = (await this.ctx.storage.get('value') ?? 0) + 1; await this.ctx.storage.put('value', value); return Response.json({value, id:this.ctx.id.toString()});} } export default {fetch(request, env) {return env.Counter.get(env.Counter.idFromName('one')).fetch(request)}};`,
			'client.tsx': `const React={createElement:(tag,props,...children)=>({tag,children})}; export default <span>counter</span>`,
			'tsconfig.json': '{"compilerOptions":{"jsx":"react"}}',
		}
		const bundle = await buildKodyAppBundle({ ...input, sourceFiles })
		const { modules } = await hydrateKodyRuntimeModules({
			...input,
			modules: bundle.modules,
		})
		const graph: RunnerGraph = {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'wrapper.js',
			entrypointName: 'PackageAppWorker',
			method: 'fetch',
			modules: {
				...modules,
				'wrapper.js': createPackageAppWorkerSource({
					mainModule: bundle.mainModule,
				}),
			},
			env: {
				__kodyPackageContext: {
					packageId: 'counter',
					kodyId: 'counter',
					sourceId: 'source-counter',
				},
			},
			runtimeMethods: {
				KODY_RUNTIME: [
					'listMcpServerNames',
					'packageRuntimeRunStart',
					'packageRuntimeRunFinish',
					'storageGet',
					'storageSet',
				],
			},
			invocation: {
				url: 'https://alice.kody.run/counter',
				method: 'GET',
				headers: [],
				body: null,
			},
		}
		await using native = await createDenoFixtureRunner({
			brokerUrl: nativeBridge.url,
			egressUrl: nativeBridge.url,
			readObject: async () => graph,
		})
		for (const value of [1, 2]) {
			const baseline = await native.invoke({
				bundleKey: 'alice/runner-inputs/counter.json',
				runToken: 'token',
				runId: crypto.randomUUID(),
			})
			const replacement = await invokeDenoSpike({
				graph,
				runToken: 'token',
				brokerUrl: denoBridge.url,
				egressUrl: denoBridge.url,
			})
			expect(replacement).toEqual(baseline)
			expect(
				JSON.parse(
					Buffer.from(
						(replacement as { body: string }).body,
						'base64',
					).toString(),
				),
			).toEqual({ value, id: 'counter:Counter:one' })
		}
		expect(denoBridge.calls).toEqual(nativeBridge.calls)
		const client = await buildKodyAppClientBundle({
			...input,
			sourceFiles,
			entryPoint: 'client.tsx',
		})
		const clientModule = await import(
			`data:text/javascript;base64,${Buffer.from(client.modules[client.mainModule] as string).toString('base64')}`
		)
		expect(clientModule.default).toEqual({ tag: 'span', children: ['counter'] })
		await expect(
			buildKodyAppClientBundle({
				...input,
				entryPoint: 'client.tsx',
				sourceFiles: {
					...sourceFiles,
					'client.tsx': `import 'node:fs'; export default 1;`,
				},
			}),
		).rejects.toThrow('server-only')
		const external = await buildKodyAppClientBundle({
			...input,
			entryPoint: 'client.tsx',
			sourceFiles: {
				...sourceFiles,
				'client.tsx': `import {h} from 'preact'; export default h;`,
			},
		})
		expect(
			collectLiteralImportSpecifiers(
				external.modules[external.mainModule] as string,
			),
		).toContain('preact')
		await expect(
			buildKodyAppClientBundle({
				...input,
				entryPoint: 'client.tsx',
				sourceFiles: {
					...sourceFiles,
					'client.tsx': `import 'https://unknown.example/mod.js'; export default 1;`,
				},
			}),
		).rejects.toThrow('Invalid prepared file path')
		const executable = await buildKodyModuleBundle({
			...input,
			entryPoint: 'entry.ts',
			sourceFiles: {
				'entry.ts': `import {gzipSync, gunzipSync} from 'node:zlib'; export default async ({value}) => Number(new TextDecoder().decode(gunzipSync(gzipSync(new TextEncoder().encode(String(value * 2))))));`,
			},
		})
		const hydrated = await hydrateKodyRuntimeModules({
			...input,
			modules: executable.modules,
		})
		const result = await invokeDenoSpike({
			graph: {
				...createDynamicWorkerCompatibilityOptions(),
				mainModule: 'executor.js',
				modules: {
					...hydrated.modules,
					'executor.js': createExecutorModuleSource({
						code: `async () => (await import('./${executable.mainModule}')).default({value:21})`,
						providers: [{ name: 'kody', fns: {} }],
						shadowGlobalThis: false,
					}),
				},
			},
			runToken: 'token',
			brokerUrl: denoBridge.url,
			egressUrl: denoBridge.url,
		})
		expect(result).toMatchObject({ result: 42 })
		const remixFiles = createRemixPackageAppFiles({
			username: 'alice',
			kodyId: 'remix-notes',
		})
		const remix = await buildKodyAppBundle({
			...input,
			entryPoint: 'app/router.ts',
			sourceFiles: remixFiles,
		})
		const remixHydrated = await hydrateKodyRuntimeModules({
			...input,
			modules: remix.modules,
		})
		graph.modules = {
			...remixHydrated.modules,
			'wrapper.js': createPackageAppWorkerSource({
				mainModule: remix.mainModule,
			}),
		}
		graph.env = {
			__kodyPackageContext: {
				packageId: 'remix-notes',
				kodyId: 'remix-notes',
				sourceId: 'source-remix',
				appBasePath: '/packages/remix-notes',
				assetBasePath: '/packages/remix-notes/_assets',
				clientModuleUrl: '/packages/remix-notes/_assets/client.js',
			},
		}
		graph.runtimeMethods!.KODY_RUNTIME!.push('packageStorageGet')
		graph.invocation = {
			url: 'https://alice.kody.run/',
			method: 'GET',
			headers: [],
			body: null,
		}
		const baseline = (await native.invoke({
			bundleKey: 'alice/runner-inputs/remix.json',
			runToken: 'token',
			runId: crypto.randomUUID(),
		})) as { body: string; status: number }
		const replacement = (await invokeDenoSpike({
			graph,
			runToken: 'token',
			brokerUrl: denoBridge.url,
			egressUrl: denoBridge.url,
		})) as { body: string; status: number }
		const html = (body: string) => {
			const text = Buffer.from(body, 'base64').toString()
			const island = text.match(/<!-- rmx:h:(h[0-9a-f]+) -->/)?.[1]
			expect(island).toBeDefined()
			return text
				.replaceAll(island!, 'island-id')
				.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, 'request-id')
		}
		expect(replacement.status).toBe(200)
		expect(html(replacement.body)).toEqual(html(baseline.body))
		expect(html(replacement.body)).toContain('Mounted at /packages/remix-notes')
		await buildKodyAppClientBundle({
			...input,
			entryPoint: 'app/assets/entry.ts',
			sourceFiles: remixFiles,
		})
	},
)
