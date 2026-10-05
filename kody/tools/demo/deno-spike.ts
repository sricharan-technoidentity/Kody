import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { STATUS_CODES } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { context } from 'esbuild'
import { awaitRunnerTask } from '../../packages/worker/src/runner/contract.ts'
import { type RunnerGraph } from '../../packages/worker/src/runner/contract.ts'
import {
	collectBundlerResolvedSpecifiers,
	collectDynamicImportExpressionNodes,
} from '../../packages/worker/src/package-runtime/import-specifiers.ts'
import { prepareDeno } from './prepare-deno.ts'
import { pinnedFetch } from '../../packages/worker/src/egress/public-fetch.ts'

const limit = 100 * 1024
const nativeModules = ['node:async_hooks', 'node:zlib']
const compatibility = `
export class RpcTarget {}
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class DurableObject extends WorkerEntrypoint {}
export function waitUntil(promise) { return globalThis[Symbol.for('kody.deno.waitUntil')](promise); }
`
const dataUrl = (text: string) =>
	`data:application/javascript;base64,${Buffer.from(text).toString('base64')}`

/** Step-one spike only: prepare legacy graphs in memory, never resolve host files or registries. */
export async function compileDenoGraph(
	graph: RunnerGraph,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted()
	if (
		Object.keys(graph.modules).length > 2000 ||
		Buffer.byteLength(JSON.stringify(graph.modules)) > 16 * 1024 * 1024
	)
		throw new Error('Authorized graph exceeds compilation limits.')
	const modules = new Map(Object.entries(graph.modules))
	if (
		modules.has('cloudflare:workers') ||
		nativeModules.some((name) => modules.has(name)) ||
		[...modules.keys()].some((key) => key.startsWith('kody:deno-import-map-'))
	)
		throw new Error('Graph shadows a trusted compatibility module.')
	modules.set('cloudflare:workers', compatibility)
	const dynamicModules = new Map<string, string>()
	const compiler = await context({
		entryPoints: [graph.mainModule],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		write: false,
		logLevel: 'silent',
		metafile: true,
		plugins: [
			{
				name: 'authorized-graph',
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
						if (nativeModules.includes(path)) return { path, external: true }
						if (
							path.startsWith('/') ||
							/^(file|https?|npm|jsr|data):/.test(path)
						)
							throw new Error(`Unauthorized module: ${path}`)
						const resolved = path.startsWith('.')
							? posix.normalize(posix.join(posix.dirname(importer), path))
							: path
						if (!modules.has(resolved))
							throw new Error(`Module is outside the authorized graph: ${path}`)
						return { path: resolved, namespace: 'graph' }
					})
					builder.onLoad({ filter: /.*/, namespace: 'graph' }, ({ path }) => {
						const dynamic = dynamicModules.get(path)
						if (dynamic) return { contents: dynamic, loader: 'js' }
						const value = modules.get(path)!
						const module = typeof value === 'string' ? { js: value } : value
						if (module.js !== undefined || module.cjs !== undefined) {
							let contents = module.js ?? module.cjs!
							const imports = collectBundlerResolvedSpecifiers(contents)
							if (!imports) throw new Error(`Unparseable graph module: ${path}`)
							// Validate even imports removed by tree shaking.
							for (const specifier of imports) {
								const resolved = specifier.startsWith('.')
									? posix.normalize(posix.join(posix.dirname(path), specifier))
									: specifier
								if (
									!nativeModules.includes(specifier) &&
									(!modules.has(resolved) ||
										specifier.startsWith('/') ||
										/^(file|https?|npm|jsr|data):/.test(specifier))
								)
									throw new Error(`Unauthorized module: ${specifier}`)
							}
							const computed = collectDynamicImportExpressionNodes(
								contents,
							).filter((node) => node.literalSpecifier === null)
							if (computed.length) {
								const hash = createHash('sha256')
									.update(path)
									.digest('hex')
									.slice(0, 20)
								const name = `__kodyDenoImport_${hash}`
								const key = `kody:deno-import-map-${hash}`
								// ponytail: per-importer maps are O(n^2); use a module loader if large graphs make this material.
								const cases = [...modules.keys(), ...nativeModules]
									.map(
										(module) =>
											`case ${JSON.stringify(module)}: return import(${JSON.stringify(module)});`,
									)
									.join('\n')
								dynamicModules.set(
									key,
									`export function resolve(value) { const raw = String(value); const key = raw.startsWith('.') ? new URL(raw, ${JSON.stringify('https://graph.invalid/' + path)}).pathname.slice(1) : raw; switch(key) { ${cases} default: return Promise.reject(new Error('Module is outside the authorized graph: ' + raw)); } }`,
								)
								modules.set(key, dynamicModules.get(key)!)
								for (const node of computed.toReversed())
									contents =
										contents.slice(0, node.start) +
										`${name}(${contents.slice(node.sourceStart, node.sourceEnd)})` +
										contents.slice(node.end)
								contents += `\nimport {resolve as ${name}} from ${JSON.stringify(key)};`
							}
							return { contents, loader: 'js' }
						}
						if (module.text !== undefined)
							return { contents: module.text, loader: 'text' }
						if (module.json !== undefined)
							return { contents: JSON.stringify(module.json), loader: 'json' }
						const bytes =
							'dataBase64' in module
								? Buffer.from(module.dataBase64!, 'base64')
								: 'data' in module
									? new Uint8Array(module.data!)
									: null
						if (bytes)
							return {
								contents: `export default new Uint8Array(${JSON.stringify([...bytes])}).buffer`,
								loader: 'js',
							}
						throw new Error(`Unsupported graph module: ${path}`)
					})
				},
			},
		],
	})
	const cancel = () => void compiler.cancel()
	signal?.addEventListener('abort', cancel, { once: true })
	try {
		signal?.throwIfAborted()
		const output = await compiler.rebuild()
		signal?.throwIfAborted()
		return output.outputFiles[0]!.text
	} finally {
		signal?.removeEventListener('abort', cancel)
		await compiler.dispose()
	}
}

export async function invokeDenoSpike(input: {
	graph: RunnerGraph
	runToken: string
	brokerUrl: string
	egressUrl: string
	executable?: string
	timeoutMs?: number
	signal?: AbortSignal
	onLog?(text: string): void
	temporaryRoot?: string
}) {
	for (const [value, maximum] of [
		[input.timeoutMs ?? input.graph.timeoutMs ?? 90_000, 2_147_483_647],
		[input.graph.bodyLimitBytes ?? limit, 32 * 1024 * 1024],
		[input.graph.responseLimitBytes ?? limit, 48 * 1024 * 1024],
	]) {
		if (!Number.isSafeInteger(value) || value! <= 0 || value! > maximum!)
			throw new Error('Invalid sandbox invocation budget.')
	}
	const deadline =
		Date.now() + (input.timeoutMs ?? input.graph.timeoutMs ?? 90_000)
	const signal = AbortSignal.any([
		AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		...(input.signal ? [input.signal] : []),
	])
	signal.throwIfAborted()
	const moduleUrl = dataUrl(await compileDenoGraph(input.graph, signal))
	signal.throwIfAborted()
	const executable = await prepareDeno(input.executable, signal)
	const egressAddresses = await awaitRunnerTask(
		lookup(new URL(input.egressUrl).hostname, {
			all: true,
		}),
		signal,
	)
	const workerUrl = dataUrl(
		await readFile(new URL('./deno-worker.mjs', import.meta.url), 'utf8'),
	)
	signal.throwIfAborted()
	const directory = await mkdtemp(
		join(input.temporaryRoot ?? tmpdir(), 'kody-deno-run-'),
	)
	const controller = new AbortController()
	const child = spawn(
		executable,
		[
			'run',
			'--no-config',
			'--no-lock',
			'--no-prompt',
			'--cached-only',
			'--node-modules-dir=none',
			'--deny-read',
			'--deny-write',
			'--deny-net',
			'--deny-env',
			'--deny-run',
			'--deny-ffi',
			'--deny-sys',
			'--deny-import',
			'--unstable-worker-options',
			'--v8-flags=--max-old-space-size=128',
			new URL('./deno-bootstrap.mjs', import.meta.url).pathname,
		],
		{
			cwd: directory,
			env: { DENO_DIR: join(directory, 'cache'), DENO_NO_UPDATE_CHECK: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	)
	const exited = new Promise<void>((resolve) => {
		child.once('exit', () => resolve())
		child.once('error', () => resolve())
	})
	const nonce = randomBytes(32).toString('hex')
	const bodyLimit = input.graph.bodyLimitBytes ?? limit
	const frameLimit = input.graph.responseLimitBytes ?? limit
	let timer: ReturnType<typeof setTimeout> | undefined
	let cancel: (() => void) | undefined
	try {
		return await new Promise<unknown>((resolve, reject) => {
			let buffer = ''
			let outputBytes = 0
			let messages = 0
			let diagnostics = ''
			let done = false
			const decoder = new StringDecoder('utf8')
			const fail = (error: unknown) => {
				if (!done) {
					done = true
					controller.abort()
					child.kill('SIGKILL')
					reject(error)
				}
			}
			timer = setTimeout(
				() =>
					fail(
						new Error(
							'Deno sandbox deadline exceeded; execution may have started.',
						),
					),
				Math.max(1, deadline - Date.now()),
			)
			cancel = () =>
				fail(
					new Error(
						input.signal?.aborted
							? 'Deno sandbox cancelled; execution may have started.'
							: 'Deno sandbox deadline exceeded; execution may have started.',
					),
				)
			signal.addEventListener('abort', cancel, { once: true })
			if (signal.aborted) {
				cancel()
				return
			}
			child.on('error', fail)
			child.once('exit', (code, signal) =>
				fail(
					new Error(`Deno sandbox exited (${signal ?? code}): ${diagnostics}`),
				),
			)
			child.stderr.on('data', (chunk: Buffer) => {
				diagnostics += chunk.toString()
				if (Buffer.byteLength(diagnostics) > limit)
					fail(new Error('Deno sandbox diagnostics limit exceeded.'))
			})
			const respond = (value: unknown) => {
				const text = JSON.stringify(value)
				if (Buffer.byteLength(text) > frameLimit)
					throw new Error('Deno bridge response limit exceeded.')
				if (!done) child.stdin.write(text + '\n')
			}
			const ids = new Set<number>()
			const bridgeControllers = new Map<number, AbortController>()
			const handle = async (message: Record<string, unknown>) => {
				if (done) return
				if (!message || typeof message !== 'object' || message.nonce !== nonce)
					throw new Error('Unauthenticated sandbox frame.')
				if (message.type === 'error')
					return fail(new Error(String(message.error)))
				if (message.type === 'result') {
					done = true
					resolve(message.result)
					return
				}
				if (message.type === 'log') {
					if (typeof message.text !== 'string')
						throw new Error('Invalid sandbox log.')
					input.onLog?.(message.text)
					return
				}
				if (message.type === 'cancel') {
					if (
						!Number.isSafeInteger(message.id) ||
						!ids.has(message.id as number)
					)
						throw new Error('Invalid sandbox cancellation.')
					bridgeControllers.get(message.id as number)?.abort()
					return
				}
				if (
					message.type !== 'bridge' ||
					!Number.isSafeInteger(message.id) ||
					(message.id as number) <= 0 ||
					ids.has(message.id as number)
				)
					throw new Error('Invalid sandbox bridge message.')
				ids.add(message.id as number)
				const bridgeController = new AbortController()
				bridgeControllers.set(message.id as number, bridgeController)
				const bridgeSignal = AbortSignal.any([
					controller.signal,
					bridgeController.signal,
				])
				try {
					let response: Response
					if (message.kind === 'capability') {
						if (typeof message.capability !== 'string')
							throw new Error('Invalid capability.')
						const [provider, method] = message.capability.split('.')
						if (
							input.graph.providers &&
							!input.graph.providers.includes(provider!)
						)
							throw new Error('Unknown provider.')
						const methods = input.graph.runtimeMethods?.[provider!]
						if (methods && !methods.includes(method!))
							throw new Error('Unknown runtime method.')
						response = await fetch(input.brokerUrl, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								'x-kody-run-token': input.runToken,
							},
							body: JSON.stringify({
								capability: message.capability,
								arguments: message.arguments,
							}),
							signal: bridgeSignal,
						})
						const text = (await boundedBody(response, bodyLimit)).toString(
							'utf8',
						)
						if (!response.ok) {
							const rejection =
								response.status === 403
									? (JSON.parse(text) as { error?: string })
									: null
							throw new Error(
								rejection?.error ?? 'Capability broker rejected the request.',
							)
						}
						respond({ id: message.id, result: text })
					} else if (message.kind === 'fetch') {
						if (
							typeof message.url !== 'string' ||
							typeof message.method !== 'string' ||
							!Array.isArray(message.headers) ||
							!message.headers.every(
								(header) =>
									Array.isArray(header) &&
									header.length === 2 &&
									header.every((value) => typeof value === 'string'),
							) ||
							(message.body !== null && typeof message.body !== 'string')
						)
							throw new Error('Invalid sandbox fetch message.')
						const url = new URL(message.url)
						if (!['https:', 'http:'].includes(url.protocol))
							throw new Error('Unsupported fetch protocol.')
						const headers = new Headers(
							message.headers as Array<[string, string]>,
						)
						headers.set('host', url.host)
						headers.set('x-kody-run-token', input.runToken)
						headers.set('x-kody-outbound-proto', url.protocol.slice(0, -1))
						response = await pinnedFetch(
							new Request(new URL(url.pathname + url.search, input.egressUrl), {
								method: message.method,
								headers,
								body:
									message.body == null
										? null
										: Buffer.from(String(message.body), 'base64'),
								redirect: 'manual',
								signal: bridgeSignal,
							}),
							egressAddresses,
						)
						const bytes = await boundedBody(response, bodyLimit)
						respond({
							id: message.id,
							result: {
								status: response.status,
								statusText: response.statusText,
								headers: [...response.headers],
								body: bytes.toString('base64'),
							},
						})
					} else throw new Error('Unknown sandbox bridge operation.')
				} catch (error) {
					respond({
						id: message.id,
						error: error instanceof Error ? error.message : String(error),
					})
				} finally {
					bridgeControllers.delete(message.id as number)
				}
			}
			child.stdout.on('data', (chunk: Buffer) => {
				outputBytes += chunk.length
				if (outputBytes > frameLimit)
					return fail(new Error('Deno sandbox output limit exceeded.'))
				buffer += decoder.write(chunk)
				let end
				while (!done && (end = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, end)
					buffer = buffer.slice(end + 1)
					if (++messages > 1000)
						return fail(new Error('Deno sandbox message limit exceeded.'))
					try {
						void handle(JSON.parse(line)).catch(fail)
					} catch (error) {
						fail(error)
					}
				}
			})
			const { modules: _modules, ...graph } = input.graph
			child.stdin.on('error', fail)
			child.stdin.write(
				JSON.stringify({
					workerUrl,
					moduleUrl,
					graph,
					nonce,
					statusTexts: STATUS_CODES,
				}) + '\n',
			)
		})
	} finally {
		clearTimeout(timer)
		if (cancel) signal.removeEventListener('abort', cancel)
		controller.abort()
		child.kill('SIGKILL')
		await exited
		await rm(directory, { recursive: true, force: true })
	}
}

async function boundedBody(response: Response, maxBytes: number) {
	const chunks: Array<Buffer> = []
	let size = 0
	if (response.body)
		for await (const chunk of response.body) {
			size += chunk.length
			if (size > maxBytes)
				throw new Error('Deno bridge response limit exceeded.')
			chunks.push(Buffer.from(chunk))
		}
	return Buffer.concat(chunks)
}
