import path from 'node:path'
import { remix } from '@pitlane/dev'
import { defineConfig } from 'vite'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import { ensureNodeOAuthProvider } from './tools/build-node-oauth-provider.ts'
import { nodeRuntimeAliases } from './tools/node-runtime-aliases.ts'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
const root = import.meta.dirname
export default defineConfig(async () => {
	await Promise.all([
		ensureWorkerBundlerModules(),
		ensureGuideCatalogModules(),
		ensureNodeOAuthProvider(),
	])
	return {
		publicDir: 'packages/worker/public',
		environments: {
			ssr: { build: { rolldownOptions: { external: [/\.wasm$/] } } },
		},
		build: { sourcemap: true, outDir: process.env.KODY_VITE_OUTDIR ?? 'dist' },
		plugins: [
			markdownAsText(),
			remix({
				serverHandler: false,
				clientEntry: 'packages/worker/client/entry.tsx',
				serverEntry: 'packages/worker/src/index.ts',
				serverEnvironments: ['ssr'],
			}),
		],
		resolve: {
			alias: [
				...nodeRuntimeAliases,
				{
					find: /#app\/hmr\.ts$/,
					replacement: path.resolve(
						root,
						'packages/worker/src/app/hmr.vite.ts',
					),
				},
				{
					find: /#app\/client-entry-assets\.ts$/,
					replacement: path.resolve(
						root,
						'packages/worker/src/app/client-entry-assets.vite.ts',
					),
				},
				...Object.entries({
					'#app': 'src/app',
					'#client': 'client',
					'#universal': 'universal',
					'#worker': 'src',
					'#mcp': 'src/mcp',
				}).map(([prefix, target]) => ({
					find: new RegExp(`^${prefix}/`),
					replacement: `${path.resolve(root, 'packages/worker', target)}/`,
				})),
			],
		},
		ssr: {
			noExternal: [
				'remix',
				'@modelcontextprotocol/server',
				'@modelcontextprotocol/sdk',
				'agents',
				'@cloudflare/codemode',
			],
		},
		oxc: { jsx: { runtime: 'automatic', importSource: 'remix/ui' } },
	}
})
