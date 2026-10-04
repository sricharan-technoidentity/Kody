import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import getPort from 'get-port'
import { packageAppRuntimeMethods } from './bridge-methods.ts'
import { type SerializedWorkerLoaderModule } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export type RunnerGraph = {
	mainModule: string
	modules: WorkerLoaderModules | Record<string, SerializedWorkerLoaderModule>
	compatibilityDate: string
	compatibilityFlags: Array<string>
	invocation?: unknown
	env?: Record<string, unknown>
	runtimeMethods?: Record<string, Array<string>>
	providers?: Array<string>
	method?: 'evaluate' | 'fetch'
	entrypointName?: string
}

const hostSource = `
import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { createWorker } from './worker-bundler.mjs';
import { posix } from 'node:path';
class Dispatcher extends RpcTarget {
  constructor(binding, token, provider) { super(); this.binding = binding; this.token = token; this.provider = provider; }
  async call(capability, json) {
    const args = JSON.parse(json);
    const response = await this.binding.fetch('https://broker.internal/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kody-run-token': this.token }, body: JSON.stringify({ capability: this.provider ? this.provider + "." + capability : capability, arguments: args }) });
    if (!response.ok) {
      const rejection = response.status === 403 ? await response.json() : null;
      throw new Error(rejection?.error ?? 'Capability broker rejected the request.');
    }
    return response.text();
  }
}
export class RuntimeBridge extends WorkerEntrypoint {
 ${packageAppRuntimeMethods
		.map(
			(method) => `async ${method}(...args) {
  const text = await new Dispatcher(this.env.BROKER, this.ctx.props.runToken, this.ctx.props.provider).call('${method}', JSON.stringify(args));
  const result = JSON.parse(text);
  if (result.error) throw new Error(result.error);
  return result.result;
 }`,
		)
		.join('\n')}
}
export class Egress extends WorkerEntrypoint {
  async fetch(request) {
    const headers = new Headers(request.headers);
    headers.set('x-kody-run-token', this.ctx.props.runToken);
    headers.set('x-kody-outbound-proto', new URL(request.url).protocol.slice(0, -1));
    return this.env.EGRESS.fetch(new Request(request, { headers }));
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/bundle' && request.method === 'POST') {
      const input = await request.json();
      const plugin = {name: 'kody-runtime-externals', setup(build) {build.onResolve({filter: /.*/}, args => {
        if (args.kind === 'entry-point') return;
        const path = posix.normalize(args.path.startsWith('.') ? posix.join(args.resolveDir ?? '', args.path) : (args.path.startsWith('/') ? args.path.slice(1) : args.path));
        if (path === '.__kody_virtual__/runtime.js' || path.endsWith('/.__kody_virtual__/runtime.js')) return {path: './' + path, external: true};
      })}};
      const clientExternals = {name: 'kody-package-app-client-externals', setup(build) {build.onResolve({filter: /^[^./]/}, args => {
        if ((input.externals ?? []).some(external => args.path === external || args.path.startsWith(external + '/'))) return {path: args.path, external: true};
      })}};
      return Response.json(await createWorker({...input, externals: undefined, __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [plugin, clientExternals]}));
    }
    if (new URL(request.url).pathname === '/ping') return new Response('ok');
    if (new URL(request.url).pathname !== '/invocations' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    const input = await request.json();
    // ponytail: isolates are per run until outbound tokens can be refreshed without changing WorkerCode.
    const graph = input.graph;
    const bindings = { ...graph.env };
    const modules = Object.fromEntries(Object.entries(graph.modules).map(([name, value]) => {
      if (!value || typeof value !== 'object' || value.dataBase64 === undefined) return [name, value];
      const {dataBase64, ...module} = value;
      return [name, {...module, data: Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0)).buffer}];
    }));
    for (const [name, methods] of Object.entries(graph.runtimeMethods ?? {})) {
      if (methods.some(method => !Object.prototype.hasOwnProperty.call(RuntimeBridge.prototype, method))) throw new Error('Unknown runtime bridge method.');
      bindings[name] = ctx.exports.RuntimeBridge({props: {provider: name, runToken: input.runToken}});
    }
    const worker = env.LOADER.get(input.runId, () => ({ mainModule: graph.mainModule, modules, compatibilityDate: graph.compatibilityDate, compatibilityFlags: graph.compatibilityFlags, env: bindings, globalOutbound: ctx.exports.Egress({ props: { runToken: input.runToken } }) }));
    const entrypoint = worker.getEntrypoint(graph.entrypointName);
    if (graph.method === 'fetch') {
      const invocation = graph.invocation;
      const body = invocation.body == null ? null : Uint8Array.from(atob(invocation.body), c => c.charCodeAt(0));
      const response = await entrypoint.fetch(new Request(invocation.url, {method: invocation.method, headers: invocation.headers, redirect: invocation.redirect, body}));
      const bytes = new Uint8Array(await response.arrayBuffer());
      // ponytail: app responses are buffered for the POC; stream when the front door moves in P7.
      const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      return Response.json({status: response.status, statusText: response.statusText, headers: [...response.headers], body: encoded});
    }
    const dispatchers = Object.fromEntries((graph.providers ?? ['kody']).map(name => [name, new Dispatcher(env.BROKER, input.runToken, graph.providers ? name : undefined)]));
    const result = await entrypoint.evaluate(dispatchers, graph.invocation ?? {});
    return Response.json(result);
  }
};`

/** Local POC supervisor. The only external workerd services are broker and egress. */
export async function startWorkerdRunner(input: {
	brokerUrl: string
	egressUrl: string
	readObject(key: string): Promise<RunnerGraph>
	artifactsDirectory?: string
}) {
	const stack = new AsyncDisposableStack()
	try {
		const directory = await mkdtemp(join(tmpdir(), 'kody-runner-'))
		stack.defer(() => rm(directory, { recursive: true, force: true }))
		const port = await getPort({ host: '127.0.0.1' })
		const require = createRequire(import.meta.url)
		const workerdRoot = dirname(require.resolve('workerd/package.json'))
		// Use the package's native binary path so signals reach workerd directly.
		const binary = (require('workerd') as { default: string }).default
		const endpoint = (name: string, url: string) => {
			const parsed = new URL(url)
			if (parsed.protocol !== 'http:')
				throw new Error('Local Runner endpoints must use HTTP.')
			return `(name = ${JSON.stringify(name)}, external = (address = ${JSON.stringify(parsed.host)}, http = (forwardedProtoHeader = "x-kody-outbound-proto")))`
		}
		const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "runner", worker = (modules = [(name = "host.js", esModule = embed "host.js"), (name = "worker-bundler.mjs", esModule = embed "worker-bundler.mjs"), (name = "esbuild.wasm", wasm = embed "esbuild.wasm")], compatibilityDate = "2026-04-16", compatibilityFlags = ["nodejs_compat", "experimental"], bindings = [(name = "LOADER", workerLoader = ()), (name = "BROKER", service = "broker"), (name = "EGRESS", service = "egress")], globalOutbound = "blocked")),
    ${endpoint('broker', input.brokerUrl)}, ${endpoint('egress', input.egressUrl)},
    (name = "blocked", network = (allow = []))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "runner")]
);`
		await copyFile(
			input.artifactsDirectory
				? join(input.artifactsDirectory, 'worker-bundler.mjs')
				: new URL('../../.generated/worker-bundler.mjs', import.meta.url),
			join(directory, 'worker-bundler.mjs'),
		)
		await copyFile(
			input.artifactsDirectory
				? join(input.artifactsDirectory, 'esbuild.wasm')
				: new URL('../../.generated/esbuild.wasm', import.meta.url),
			join(directory, 'esbuild.wasm'),
		)
		await writeFile(join(directory, 'host.js'), hostSource)
		await writeFile(join(directory, 'config.capnp'), config)
		const process = spawn(
			binary,
			[
				'serve',
				'--experimental',
				'-I',
				dirname(workerdRoot),
				join(directory, 'config.capnp'),
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		)
		let diagnostics = ''
		process.stderr.on('data', (chunk) => {
			diagnostics += String(chunk)
		})
		let spawnError: Error | undefined
		process.on('error', (error) => {
			spawnError = error
		})
		const url = `http://127.0.0.1:${port}`
		stack.defer(async () => {
			if (
				process.pid &&
				process.exitCode === null &&
				process.signalCode === null
			) {
				const exited = once(process, 'exit')
				process.kill()
				const timer = setTimeout(() => process.kill('SIGKILL'), 5000)
				try {
					await exited
				} finally {
					clearTimeout(timer)
				}
			}
		})
		const deadline = Date.now() + 10000
		for (;;) {
			if (spawnError || process.exitCode !== null)
				throw new Error(
					`Runner failed to start: ${spawnError?.message ?? diagnostics}`,
				)
			if (
				await fetch(`${url}/ping`)
					.then((response) => response.ok)
					.catch(() => false)
			)
				break
			if (Date.now() >= deadline)
				throw new Error(`Runner readiness timed out: ${diagnostics}`)
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		const owned = stack.move()
		return {
			url,
			async createWorker(input: {
				files: Record<string, string>
				entryPoint: string
				jsx?: string
				jsxImportSource?: string
				externals?: Array<string>
			}) {
				const response = await fetch(`${url}/bundle`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(input),
				})
				if (!response.ok)
					throw new Error(
						`Runner bundler failed: ${response.status} ${await response.text()} ${diagnostics}`,
					)
				return response.json() as Promise<{
					mainModule: string
					modules: WorkerLoaderModules
				}>
			},
			async invoke(invocation: {
				bundleKey: string
				runToken: string
				runId: string
			}) {
				const graph = await input.readObject(invocation.bundleKey)
				const response = await fetch(`${url}/invocations`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						graph,
						runToken: invocation.runToken,
						runId: invocation.runId,
					}),
				})
				if (!response.ok)
					throw new Error(
						`Runner failed: ${response.status} ${await response.text()} ${diagnostics}`,
					)
				return response.json() as Promise<unknown>
			},
			[Symbol.asyncDispose]: () => owned.disposeAsync(),
		}
	} catch (error) {
		await stack.disposeAsync()
		throw error
	}
}
