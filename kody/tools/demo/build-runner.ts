import { build } from 'esbuild'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

await promisify(execFile)(process.execPath, [
	'tools/build-worker-bundler-modules.ts',
])
await mkdir('dist/runner/artifacts', { recursive: true })
await build({
	entryPoints: ['tools/demo/runner-host.ts'],
	outfile: 'dist/runner/host.mjs',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node26',
	packages: 'external',
})
for (const name of ['worker-bundler.mjs', 'esbuild.wasm'])
	await copyFile(
		`packages/worker/.generated/${name}`,
		`dist/runner/artifacts/${name}`,
	)
await writeFile(
	'dist/runner/package.json',
	JSON.stringify({
		private: true,
		type: 'module',
		dependencies: {
			'@aws-sdk/client-s3': '3.1143.0',
			workerd: '1.20260815.1',
			'get-port': '7.2.0',
		},
	}),
)
await copyFile('tools/demo/Runner.Dockerfile', 'dist/runner/Dockerfile')
console.info(
	'Runner artifact: dist/runner (ARM64 Docker build context; deployment is external).',
)
