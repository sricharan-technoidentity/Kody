import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
export const nodeOAuthProviderPath = resolve(
	root,
	'packages/worker/.generated/node-oauth-provider.mjs',
)
let built: Promise<void> | undefined
export function ensureNodeOAuthProvider() {
	return (built ??= (async () => {
		await mkdir(resolve(root, 'packages/worker/.generated'), {
			recursive: true,
		})
		await build({
			entryPoints: [
				resolve(
					root,
					'node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js',
				),
			],
			outfile: nodeOAuthProviderPath,
			bundle: true,
			format: 'esm',
			platform: 'node',
			packages: 'external',
			plugins: [
				{
					name: 'node-oauth-host',
					setup(plugin) {
						plugin.onLoad(
							{ filter: /oauth-provider\.js$/ },
							async ({ path }) => ({
								contents: (await readFile(path, 'utf8'))
									.replace(
										'from "cloudflare:workers"',
										`from ${JSON.stringify(resolve(root, 'packages/worker/src/front-door/host-context.ts'))}`,
									)
									// A lexical compatibility declaration enables CIMD only with the checked, DNS-pinned fetch below.
									.replace(
										'import { WorkerEntrypoint }',
										`import { publicMetadataFetch as fetch } from ${JSON.stringify(resolve(root, 'packages/worker/src/egress/public-fetch.ts'))};\nconst Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };\nimport { WorkerEntrypoint }`,
									),
								loader: 'js',
							}),
						)
					},
				},
			],
		})
	})())
}
