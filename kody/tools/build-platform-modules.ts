import { createHash } from 'node:crypto'
import {
	copyFile,
	link,
	mkdir,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { packageAppRemixSubpaths } from '#worker/package-runtime/package-app-remix-subpaths.ts'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Retained OAuth/code utilities and vendored Remix assets, not sandbox execution.
 * Remix subpaths use shared chunks so browser and server components have one
 * runtime instance. Version/lockfile stamps avoid rebuilding unchanged assets.
 * Keep the generated import locations stable for existing application modules.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const platformGeneratedDir = path.join(
	repoRoot,
	'packages/worker/.generated',
)
export const platformVisibleDir = path.join(
	repoRoot,
	'packages/worker/src/node_modules/.kody-generated',
)
const leftoverSrcGeneratedDir = path.join(
	repoRoot,
	'packages/worker/src/generated',
)
export const leftoverSrcGeneratedBundlerNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'esbuild.wasm',
	'esbuild-wasm.mjs',
	'worker-bundler.stamp.json',
] as const
export const packageAppRemixModuleName = 'package-app-remix.mjs'
const generatedArtifactNames = [
	'codemode-host.mjs',
	'oauth-provider.mjs',
	packageAppRemixModuleName,
] as const
const leftoverWranglerVisibleNames = [
	...generatedArtifactNames,
	'esbuild-wasm.mjs',
] as const
const stampPath = path.join(platformGeneratedDir, 'platform-modules.stamp.json')

const nodeBuiltins = new Set([
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'crypto',
	'events',
	'fs',
	'http',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'stream',
	'tls',
	'url',
	'util',
	'worker_threads',
	'zlib',
])

/**
 * Preserve compatibility imports and normalize builtins for Node/Deno.
 */
const externalsPlugin: Plugin = {
	name: 'platform-externals',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^cloudflare:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^[a-z_]+$/ }, (args) => {
			if (!nodeBuiltins.has(args.path)) return null
			return { path: `node:${args.path}`, external: true }
		})
	},
}

async function readStamp(): Promise<string | null> {
	try {
		return await readFile(stampPath, 'utf8')
	} catch {
		return null
	}
}

function resolveOAuthProviderPackageDir() {
	return path.join(
		repoRoot,
		'node_modules',
		'@cloudflare',
		'workers-oauth-provider',
	)
}

function resolveRemixPackageDir() {
	return path.join(repoRoot, 'node_modules', 'remix')
}

async function buildStampContent(
	oauthProviderPackageDir: string,
	remixPackageDir: string,
) {
	const oauthProviderPackageJson = await readFile(
		path.join(oauthProviderPackageDir, 'package.json'),
		'utf8',
	)
	// The `remix` meta-package pins its `@remix-run/*` dependencies by range,
	// so the installed lockfile decides which bytes land in the vendored set;
	// stamp the lockfile too so a `npm update` of those packages regenerates.
	const remixPackageJson = await readFile(
		path.join(remixPackageDir, 'package.json'),
		'utf8',
	)
	const lockfile = await readFile(
		path.join(repoRoot, 'package-lock.json'),
		'utf8',
	)
	const generatorSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
	const esbuildVersion = (
		JSON.parse(
			await readFile(
				path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'),
				'utf8',
			),
		) as { version: string }
	).version
	const hash = createHash('sha256')
		.update(oauthProviderPackageJson)
		.update(remixPackageJson)
		.update(packageAppRemixSubpaths.join('\n'))
		.update(lockfile)
		.update(esbuildVersion)
		.update(generatorSource)
		.digest('hex')
	return JSON.stringify({ hash }, null, '\t')
}

type RemixExportTarget = string | { default?: string; types?: string }

/**
 * Bundles the Workers-safe `remix/<subpath>` entries into one code-split ESM
 * file set and serializes it as the module `package-app-remix.mjs` exports:
 * `remixVersion` plus `files`, keyed relative to `node_modules/remix/`.
 */
async function buildPackageAppRemixModule(remixPackageDir: string) {
	const remixPackage = JSON.parse(
		await readFile(path.join(remixPackageDir, 'package.json'), 'utf8'),
	) as { version: string; exports: Record<string, RemixExportTarget> }
	const entryPoints: Record<string, string> = {}
	const vendoredExports: Record<string, string> = {
		'./package.json': './package.json',
	}
	for (const subpath of packageAppRemixSubpaths) {
		const target = remixPackage.exports[`./${subpath}`]
		const targetFile =
			typeof target === 'string' ? target : (target?.default ?? null)
		if (!targetFile) {
			throw new Error(
				`remix@${remixPackage.version} does not export "./${subpath}"; update packageAppRemixSubpaths.`,
			)
		}
		entryPoints[subpath] = path.join(remixPackageDir, targetFile)
		vendoredExports[`./${subpath}`] = `./dist/${subpath}.js`
	}
	// `platform: 'neutral'` keeps esbuild from injecting Node or browser
	// shims; the same output feeds the Worker bundle and the browser bundle.
	// Node builtins stay external in `node:` form: the package-app isolate
	// runs with `nodejs_compat`, and the browser bundle check rejects any
	// subpath that still needs one (`middleware/async-context`).
	const distOutdir = path.join(remixPackageDir, 'dist')
	const result = await build({
		entryPoints,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['module', 'main'],
		conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
		target: 'es2022',
		minify: true,
		write: false,
		outdir: distOutdir,
		chunkNames: 'chunks/[name]-[hash]',
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	const files: Record<string, string> = {
		'package.json': JSON.stringify(
			{
				name: 'remix',
				version: remixPackage.version,
				type: 'module',
				exports: vendoredExports,
			},
			null,
			'\t',
		),
	}
	for (const output of result.outputFiles) {
		const relative = path
			.relative(distOutdir, output.path)
			.replaceAll(path.sep, '/')
		if (relative.startsWith('..')) {
			throw new Error(
				`remix prebuild emitted "${output.path}" outside the dist directory.`,
			)
		}
		files[`dist/${relative}`] = output.text
	}
	const serialized = [
		'// Generated by tools/build-platform-modules.ts; do not edit.',
		`export const remixVersion = ${JSON.stringify(remixPackage.version)};`,
		`export const files = ${JSON.stringify(files)};`,
		'',
	].join('\n')
	await writeFile(
		path.join(platformGeneratedDir, packageAppRemixModuleName),
		serialized,
	)
}

async function pathExists(filePath: string) {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

async function wranglerVisibleModulesExist() {
	const results = await Promise.all(
		generatedArtifactNames.map((name) =>
			pathExists(path.join(platformVisibleDir, name)),
		),
	)
	return results.every(Boolean)
}

export async function removeLeftoverSrcGeneratedBundlerArtifacts() {
	for (const directory of [
		leftoverSrcGeneratedDir,
		platformGeneratedDir,
		platformVisibleDir,
	])
		for (const name of leftoverSrcGeneratedBundlerNames)
			await rm(path.join(directory, name), { force: true })
}

async function materializeWranglerVisibleModules() {
	await mkdir(platformVisibleDir, { recursive: true })
	await Promise.all(
		leftoverWranglerVisibleNames.map((name) =>
			rm(path.join(platformVisibleDir, name), { force: true }),
		),
	)
	for (const name of generatedArtifactNames) {
		const from = path.join(platformGeneratedDir, name)
		const to = path.join(platformVisibleDir, name)
		try {
			await link(from, to)
		} catch {
			await copyFile(from, to)
		}
	}
}

/** Idempotent: skips the esbuild work when the stamp is already current. */
export async function ensurePlatformModules() {
	const oauthProviderPackageDir = resolveOAuthProviderPackageDir()
	const remixPackageDir = resolveRemixPackageDir()
	const stampContent = await buildStampContent(
		oauthProviderPackageDir,
		remixPackageDir,
	)
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	await rm(path.join(platformGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
	if (
		(await readStamp()) === stampContent &&
		(await wranglerVisibleModulesExist())
	) {
		return
	}

	await mkdir(platformGeneratedDir, { recursive: true })
	await build({
		entryPoints: {
			'oauth-provider': path.join(
				oauthProviderPackageDir,
				'dist/oauth-provider.js',
			),
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outdir: platformGeneratedDir,
		outExtension: { '.js': '.mjs' },
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	// The host needs codemode's codec and pure helpers, not its Workers runtime.
	await build({
		stdin: {
			contents:
				"export {normalizeCode, sanitizeToolName, resolveProvider, ToolDispatcher} from '@cloudflare/codemode'",
			resolveDir: repoRoot,
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		minify: true,
		outfile: path.join(platformGeneratedDir, 'codemode-host.mjs'),
		plugins: [
			{
				name: 'codemode-host',
				setup(build) {
					build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
						path: 'host-markers',
						namespace: 'codemode-host',
					}))
					build.onLoad({ filter: /.*/, namespace: 'codemode-host' }, () => ({
						contents:
							'export class RpcTarget {} export class DurableObject {} export class WorkerEntrypoint {}',
					}))
				},
			},
		],
	})
	await buildPackageAppRemixModule(remixPackageDir)
	await writeFile(stampPath, stampContent)
	await rm(path.join(platformGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
	await materializeWranglerVisibleModules()
	await fsyncGeneratedDir()
}

async function fsyncGeneratedDir() {
	const handle = await open(platformGeneratedDir, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await ensurePlatformModules()
}
