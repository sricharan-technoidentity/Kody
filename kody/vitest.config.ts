import { defineConfig } from 'vitest/config'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
import { suppressThirdPartySourcemapWarnings } from './tools/vite-suppress-sourcemap-warnings.ts'

export default defineConfig({
	plugins: [suppressThirdPartySourcemapWarnings(), markdownAsText()],
	test: {
		projects: ['./vitest.node.config.ts', './vitest.mcp-e2e.config.ts'],
	},
})
