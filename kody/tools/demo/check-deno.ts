import { spawn } from 'node:child_process'
import { prepareDeno } from './prepare-deno.ts'
import { prepareTemporal } from './prepare-temporal.ts'

const deno = await prepareDeno()
const temporal = await prepareTemporal()
const child = spawn(
	'npx',
	[
		'vitest',
		'run',
		'--project',
		'node-unit',
		'--maxWorkers',
		'1',
		'packages/worker/src/runner/deno.node.test.ts',
		'packages/worker/src/package-runtime/module-graph.node.test.ts',
		'packages/worker/src/package-runtime/package-app-remix.node.test.ts',
		'packages/worker/src/package-runtime/npm-preparation.node.test.ts',
		'packages/worker/src/package-runtime/package-storage.node.test.ts',
		'packages/worker/src/package-runtime/package-secret-authority.node.test.ts',
		'packages/worker/src/mcp/execute-console-capture.node.test.ts',
		'packages/worker/src/runner/contract.node.test.ts',
		'packages/worker/src/aws/agentcore-runner.node.test.ts',
		'tools/demo/runner-host.node.test.ts',
		'tools/demo/build-runner.node.test.ts',
		'tools/demo/aws-runtime.node.test.ts',
		'tools/demo/aws-check.node.test.ts',
		'tools/demo/runner-integration.node.test.ts',
		'tools/demo/deno-spike.node.test.ts',
		'tools/demo/deno-security.node.test.ts',
		'tools/demo/package-build-tools.node.test.ts',
	],
	{
		stdio: 'inherit',
		env: {
			...process.env,
			KODY_RUNNER_BACKEND: 'deno',
			KODY_DENO_EXECUTABLE: deno,
			KODY_TEMPORAL_EXECUTABLE: temporal,
		},
	},
)
child.on('error', (error) => {
	console.error(error)
	process.exitCode = 1
})
child.on('exit', (code) => {
	process.exitCode = code ?? 1
})
