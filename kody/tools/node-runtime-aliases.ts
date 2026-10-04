import { resolve } from 'node:path'
import { nodeOAuthProviderPath } from './build-node-oauth-provider.ts'
const root = resolve(import.meta.dirname, '..')
export const nodeRuntimeAliases = [
	{
		find: 'cloudflare:workers',
		replacement: resolve(
			root,
			'packages/worker/src/front-door/host-context.ts',
		),
	},
	{
		find: '@cloudflare/workers-oauth-provider',
		replacement: nodeOAuthProviderPath,
	},
	{
		find: './node_modules/.kody-generated/oauth-provider.mjs',
		replacement: nodeOAuthProviderPath,
	},
	...['og-image-assets', 'og-resvg-wasm', 'og-binary-assets'].flatMap(
		(name) => [
			{
				find: `#worker/og/${name}.ts`,
				replacement: resolve(root, `packages/worker/src/og/${name}.node.ts`),
			},
			{
				find: new RegExp(`/og/${name}\\.ts$`),
				replacement: resolve(root, `packages/worker/src/og/${name}.node.ts`),
			},
		],
	),
]
