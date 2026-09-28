import { spawnSync } from 'node:child_process'
import { resolveNpmInvocation } from './node-runtime.ts'

const script = process.argv[2]
if (!script) {
	throw new Error('Usage: node tools/run-npm-script-with-ci.ts <npm-script>')
}

const npm = resolveNpmInvocation(process.env)
const result = spawnSync(
	npm.command,
	[...npm.argsPrefix, 'run', script, ...process.argv.slice(3)],
	{
		stdio: 'inherit',
		env: { ...process.env, CI: '1' },
	},
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
