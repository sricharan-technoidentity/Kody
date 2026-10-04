import { defineProject, mergeConfig } from 'vitest/config'
import nodeProject from './vitest.node.config.ts'
import { sharedProjectConfig } from './vitest-shared.ts'

// This suite is intentionally just a couple of smoke journeys, but each one
// boots an isolated Node/PGlite/Temporal server and runs a real
// OAuth + MCP handshake. Concurrent local validation needs more headroom than
// an isolated run.
const mcpE2eTimeout = process.env.CI ? 120_000 : 90_000

const config = mergeConfig(
	mergeConfig(sharedProjectConfig, nodeProject),
	defineProject({
		test: {
			name: 'mcp-e2e',
			environment: 'node',
			include: ['**/*.mcp-e2e.test.ts'],
			testTimeout: mcpE2eTimeout,
			hookTimeout: mcpE2eTimeout,
			// The native Runner and process-wide outbound mock share a process,
			// so transport files run sequentially.
			fileParallelism: false,
		},
	}),
)

// Vite merges include arrays; the transport project must not inherit node-unit files.
config.test!.include = ['**/*.mcp-e2e.test.ts']
export default config
