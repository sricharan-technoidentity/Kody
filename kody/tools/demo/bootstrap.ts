import { type createFrontDoorTestEnv as createFrontDoorEnv } from '#worker/test-support/front-door.ts'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import { createServer } from 'vite'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createSourceFixture } from './source-fixture.ts'
import { temporalServerOptions } from './temporal-options.ts'
import { prepareTemporal } from './prepare-temporal.ts'
import { suppressThirdPartySourcemapWarnings } from '#tools/vite-suppress-sourcemap-warnings.ts'

/** Shared browser/demo bootstrap; no operator .env is loaded. */
export async function startLocalPoc(input: {
	port: number
	uiPort?: number
	decorateActivities?: Parameters<
		typeof createFrontDoorEnv
	>[0]['decorateActivities']
	beforeServe?: (
		env: Awaited<ReturnType<typeof createFrontDoorEnv>>,
		context: {
			fixture: Awaited<ReturnType<typeof createSourceFixture>>
			loadModule: (path: string) => Promise<Record<string, unknown>>
		},
	) => Promise<void>
	control?: (request: Request) => Promise<Response | undefined>
}) {
	const executable = await prepareTemporal()
	Object.assign(
		process.env,
		parse(await readFile('packages/worker/.env.example', 'utf8')),
		parse(await readFile('packages/worker/.env.test', 'utf8')),
	)
	process.env.KODY_TEMPORAL_EXECUTABLE = executable
	const stack = new AsyncDisposableStack()
	try {
		const fixture = await createSourceFixture()
		stack.defer(() => fixture.close())
		const vite = await createServer({
			envDir: false,
			plugins: [suppressThirdPartySourcemapWarnings()],
			server: {
				host: '127.0.0.1',
				middlewareMode: true,
				hmr: {
					port: await (await import('get-port')).default({ host: '127.0.0.1' }),
				},
			},
			appType: 'custom',
			optimizeDeps: {
				noDiscovery: true,
				include: [
					'remix/ui',
					'remix/ui/jsx-runtime',
					'remix/ui/jsx-dev-runtime',
					'remix/ui-hmr',
					'remix/ui/tabs',
					'remix/ui/combobox/primitives',
					'remix/routes',
					'remix/route-pattern/href',
					'remix/route-pattern/match',
					'@sentry/browser',
					'@simplewebauthn/browser',
					'qrcode',
				],
			},
		})
		stack.defer(() => vite.close())
		const { createFrontDoorTestEnv } = (await vite.ssrLoadModule(
			'/packages/worker/src/test-support/front-door.ts',
		)) as { createFrontDoorTestEnv: typeof createFrontDoorEnv }
		const handler = (await vite.ssrLoadModule('/packages/worker/src/index.ts'))
			.default
		const origin = `http://127.0.0.1:${input.port}`
		const env = await createFrontDoorTestEnv({
			handler,
			origin,
			sourceFixture: fixture,
			decorateActivities: input.decorateActivities,
			temporalServer: temporalServerOptions({
				executable,
				uiPort: input.uiPort,
			}),
		})
		stack.defer(() => env.close())
		await input.beforeServe?.(env, {
			fixture,
			loadModule: (path) => vite.ssrLoadModule(path),
		})
		await env.bindings.TEMPORAL!.client('app')
		const server = await startFrontDoorServer({
			port: input.port,
			async fetch(request) {
				const controlled = await input.control?.(request)
				if (controlled) return controlled
				const url = new URL(request.url)
				if (
					/^\/@(?:vite|fs|id)\//.test(url.pathname) ||
					[
						'/packages/worker/client/',
						'/packages/worker/universal/',
						'/packages/shared/src/',
						'/node_modules/',
					].some((prefix) => url.pathname.startsWith(prefix))
				) {
					url.searchParams.delete('import')
					const modulePath = url.pathname.startsWith('/@id/')
						? url.pathname.slice(5).replace('__x00__', '\0')
						: url.pathname
					const transformed = await vite.transformRequest(
						modulePath + url.search,
					)
					if (transformed)
						return new Response(transformed.code, {
							headers: { 'Content-Type': 'text/javascript' },
						})
				}
				return env.fetch(request)
			},
		})
		stack.use(server)
		const response = await fetch(`${origin}/health`, {
			signal: AbortSignal.timeout(10000),
		})
		if (!response.ok)
			throw new Error(`Application readiness failed: HTTP ${response.status}`)
		await response.body?.cancel()
		const owned = stack.move()
		return {
			origin,
			env,
			fixture,
			temporalAddress: await env.temporalAddress(),
			close: () => owned.disposeAsync(),
		}
	} catch (error) {
		await stack.disposeAsync()
		throw error
	}
}
