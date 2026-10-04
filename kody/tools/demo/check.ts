import { spawn } from 'node:child_process'
import { prepareTemporal } from './prepare-temporal.ts'

const executable = await prepareTemporal()
const files = [
	'temporal/execute-run',
	'temporal/webhook-delivery',
	'temporal/job-run',
	'temporal/publish-package',
	'broker/capability-broker',
	'egress/egress-proxy',
	'storage-cell/storage-cell',
	'front-door/read-write-split',
	'security/isolation',
	'aws/frozen-keys',
	'runner/workerd',
	'test-support/aws/temporal-env',
	'temporal/package-workflow',
	'temporal/run-state',
].map((file) => `packages/worker/src/${file}.node.test.ts`)
const child = spawn(
	'npx',
	[
		'vitest',
		'run',
		'--project',
		'node-unit',
		'--maxWorkers',
		'1',
		...files,
		'tools/demo/',
		'packages/worker/src/repo/code-interpreter-workspace.node.test.ts',
	],
	{
		stdio: 'inherit',
		env: { ...process.env, KODY_TEMPORAL_EXECUTABLE: executable },
	},
)
child.on('error', (error) => {
	console.error(error)
	process.exitCode = 1
})
child.on('exit', (code) => {
	process.exitCode = code ?? 1
})
