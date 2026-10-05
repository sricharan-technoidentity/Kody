import { build } from 'esbuild'
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { denoVersion, denoArm64Sha256 } from './prepare-deno.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'

export async function buildRunner(directory = 'dist/runner') {
	await rm(directory, { recursive: true, force: true })
	await mkdir(directory, { recursive: true })
	const output = await build({
		entryPoints: [new URL('./runner-host.ts', import.meta.url).pathname],
		outfile: join(directory, 'host.mjs'),
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node26',
		packages: 'external',
		// Type-only edges must not pull the legacy supervisor into the standalone host.
		tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } },
		metafile: true,
	})
	if (
		Object.keys(output.metafile.inputs).some((path) =>
			/(?:worker-bundler|runner\/supervisor\.ts)/.test(path),
		)
	)
		throw new Error('Runner artifact contains legacy execution code.')
	for (const name of ['deno-bootstrap.mjs', 'deno-worker.mjs'])
		await copyFile(new URL(`./${name}`, import.meta.url), join(directory, name))
	const require = createRequire(import.meta.url)
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'@babel/parser': require('@babel/parser/package.json').version,
				'@aws-sdk/client-s3': require('@aws-sdk/client-s3/package.json')
					.version,
				esbuild: require('esbuild/package.json').version,
			},
		}),
	)
	await writeFile(
		join(directory, 'Dockerfile'),
		(await readFile(new URL('./Runner.Dockerfile', import.meta.url), 'utf8'))
			.replaceAll('__DENO_VERSION__', denoVersion)
			.replaceAll('__DENO_SHA256__', denoArm64Sha256),
	)
	return directory
}

if (isExecutedDirectly(import.meta.url)) {
	await buildRunner()
	console.info(
		'Runner artifact: dist/runner (ARM64 Docker build context; deployment is external).',
	)
}
