import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions, type Plugin, type Loader } from 'esbuild'
import { resolve, legacy, type Package } from 'resolve.exports'
import ts from 'typescript'
import { resolveWorkspaceSourceFilePath } from './module-graph-paths.ts'
import { isBarePackageImportSpecifier } from './import-specifiers.ts'
import { prepareNpmFiles } from './npm-preparation.ts'

function workspacePath(path: string) {
	if (path.includes('\\') || /(^\/|^[a-z]+:)/i.test(path))
		throw new Error(`Invalid prepared file path: ${path}`)
	const normalized = posix.normalize(path)
	if (normalized === '..' || normalized.startsWith('../'))
		throw new Error(`File escapes prepared workspace: ${path}`)
	return normalized
}

export class PackageFileSystem {
	private files = new Map<string, string>()
	constructor(files: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(files))
			this.write(path, content)
	}
	read(path: string) {
		return this.files.get(workspacePath(path)) ?? null
	}
	write(path: string, content: string) {
		this.files.set(workspacePath(path), content)
	}
	delete(path: string) {
		this.files.delete(workspacePath(path))
	}
	list(prefix = '') {
		return [...this.files.keys()].filter((key) => key.startsWith(prefix))
	}
	async flush() {}
}

export async function createFileSystemSnapshot(
	entries:
		| AsyncIterable<readonly [string, string]>
		| Iterable<readonly [string, string]>,
) {
	const snapshot = new PackageFileSystem()
	for await (const [path, content] of entries) snapshot.write(path, content)
	return snapshot
}

export type BundleOptions = {
	files: Record<string, string>
	entryPoint: string
	externals?: Array<string>
	jsx?: string
	jsxImportSource?: string
	bundle?: boolean
	target?: string
	minify?: boolean
	sourcemap?: boolean
	define?: Record<string, string>
	loader?: Record<string, Loader>
	conditions?: Array<string>
	virtualModules?: Record<string, string>
	allowUnresolvedBareImports?: boolean
	registry?: string
	signal?: AbortSignal
	__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: Array<unknown>
}

/** Resolve exclusively from trusted prepared files; no host-FS fallback. */
export async function createWorker(options: BundleOptions) {
	const files = Object.fromEntries(
		Object.entries(await prepareNpmFiles(options.files, options)).map(
			([path, text]) => [workspacePath(path), text],
		),
	)
	const conditions = options.conditions ?? ['workerd', 'worker', 'browser']
	const resolveFile = (path: string) =>
		resolveWorkspaceSourceFilePath({ files, path: workspacePath(path) })
	const resolveImport = (
		specifier: string,
		importer: string,
		require: boolean,
	): string => {
		if (specifier.startsWith('.') || !importer) {
			const found = resolveFile(posix.join(posix.dirname(importer), specifier))
			if (found) return found
		} else {
			workspacePath(specifier)
			const parts = specifier.split('/')
			const name = parts.splice(0, specifier.startsWith('@') ? 2 : 1).join('/')
			for (
				let directory = posix.dirname(importer);
				;
				directory = posix.dirname(directory)
			) {
				const root = posix.join(directory, 'node_modules', name)
				const manifest = files[`${root}/package.json`]
				if (manifest) {
					const pkg = JSON.parse(manifest) as Package
					const targets = resolve(pkg, specifier, {
						conditions,
						require,
						browser: true,
					}) ?? [
						parts.length
							? parts.join('/')
							: legacy(pkg, {
									browser: true,
									fields: ['browser', 'module', 'main'],
								}) || './index.js',
					]
					for (const target of targets) {
						if (
							typeof target !== 'string' ||
							(!target.startsWith('./') && pkg.exports)
						)
							throw new Error(`Invalid package target: ${specifier}`)
						const candidate = workspacePath(posix.join(root, target))
						if (!candidate.startsWith(root + '/'))
							throw new Error(`Package target escapes its root: ${specifier}`)
						const found = resolveFile(candidate)
						if (found) return found
					}
					break
				}
				if (directory === '.') break
			}
		}
		throw new Error(
			`Module is outside prepared files: ${specifier} (from ${importer})`,
		)
	}
	const plugin: Plugin = {
		name: 'prepared-package-files',
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => {
				if (
					args.kind !== 'entry-point' &&
					(args.path === 'cloudflare:workers' ||
						args.path === 'node:async_hooks' ||
						args.path === 'node:zlib' ||
						options.externals?.includes(args.path))
				)
					return { path: args.path, external: true }
				if (options.virtualModules?.[args.path] !== undefined)
					return { path: args.path, namespace: 'virtual' }
				try {
					return {
						path: resolveImport(
							args.path,
							args.importer,
							args.kind === 'require-call',
						),
						namespace: 'prepared',
					}
				} catch (error) {
					if (
						options.allowUnresolvedBareImports &&
						isBarePackageImportSpecifier(args.path) &&
						error instanceof Error &&
						error.message.startsWith('Module is outside prepared files:')
					)
						return { path: args.path, external: true }
					throw error
				}
			})
			builder.onLoad({ filter: /.*/, namespace: 'virtual' }, ({ path }) => ({
				contents: options.virtualModules![path],
				loader: 'js',
			}))
			builder.onLoad({ filter: /.*/, namespace: 'prepared' }, ({ path }) => {
				const extension = posix.extname(path)
				const loader =
					options.loader?.[extension] ??
					(
						{
							'.ts': 'ts',
							'.mts': 'ts',
							'.cts': 'ts',
							'.tsx': 'tsx',
							'.jsx': 'jsx',
							'.json': 'json',
							'.txt': 'text',
							'.css': 'css',
						} as Record<string, Loader>
					)[extension] ??
					'js'
				return {
					contents: files[path],
					loader,
					resolveDir: posix.dirname(path) === '.' ? '' : posix.dirname(path),
				}
			})
		},
	}
	const result = await build({
		absWorkingDir: '/',
		entryPoints: [options.entryPoint],
		bundle: options.bundle ?? true,
		platform: 'browser',
		format: 'esm',
		target: options.target ?? 'es2022',
		write: false,
		logLevel: 'silent',
		outfile: '/bundle.js',
		jsx: options.jsx as BuildOptions['jsx'],
		jsxImportSource: options.jsxImportSource,
		define: options.define,
		minify: options.minify,
		sourcemap: options.sourcemap ? 'inline' : false,
		plugins: [
			...((options.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired ??
				[]) as Array<Plugin>),
			plugin,
		],
	})
	if (result.outputFiles.length !== 1)
		throw new Error('Package bundle emitted unsupported secondary assets.')
	return {
		mainModule: 'bundle.js',
		modules: { 'bundle.js': result.outputFiles[0]!.text } as Record<
			string,
			string
		>,
		warnings: result.warnings.map((warning) => warning.text),
	}
}

/** Target-aware identity only; no unbounded process-global compilation cache. */
export function createCompilationCacheKey(target: string, input: unknown) {
	return createHash('sha256')
		.update(JSON.stringify([target, input]))
		.digest('hex')
}

type FileSystem = Pick<
	PackageFileSystem,
	'read' | 'write' | 'delete' | 'list' | 'flush'
>
let compilerLibraries: Map<string, string> | undefined

export async function createTypescriptLanguageService({
	fileSystem,
}: {
	fileSystem: FileSystem
}) {
	if (!compilerLibraries) {
		const directory = dirname(fileURLToPath(import.meta.resolve('typescript')))
		compilerLibraries = new Map(
			readdirSync(directory)
				.filter((name) => /^lib(?:\.[\w.]+)?\.d\.ts$/.test(name))
				.map((name) => [
					`/.__typescript__/${name}`,
					readFileSync(join(directory, name), 'utf8'),
				]),
		)
	}
	const libraries = compilerLibraries
	const key = (path: string) => posix.normalize(path).replace(/^\//, '')
	const readFile = (path: string) =>
		libraries.get(path) ?? fileSystem.read(key(path)) ?? undefined
	const fileExists = (path: string) => readFile(path) !== undefined
	// Preserve the existing checker contract: all snapshot TS files are roots; callers select diagnostics.
	const readDirectory = (root: string, extensions?: ReadonlyArray<string>) =>
		fileSystem
			.list(root === '/' ? '' : key(root))
			.filter(
				(path) =>
					!extensions ||
					extensions.some((extension) => path.endsWith(extension)),
			)
			.map((path) => '/' + path)
	const config = fileSystem.read('tsconfig.json')
	const configResult = config
		? ts.parseConfigFileTextToJson('tsconfig.json', config)
		: { config: {} }
	if (configResult.error)
		throw new Error(
			ts.flattenDiagnosticMessageText(configResult.error.messageText, '\n'),
		)
	const parsed = ts.parseJsonConfigFileContent(
		configResult.config,
		{ useCaseSensitiveFileNames: true, readFile, fileExists, readDirectory },
		'/',
	)
	let version = 0
	const wrapped = {
		read: fileSystem.read.bind(fileSystem),
		list: fileSystem.list.bind(fileSystem),
		flush: fileSystem.flush.bind(fileSystem),
		write(path: string, content: string) {
			fileSystem.write(path, content)
			version++
		},
		delete(path: string) {
			fileSystem.delete(path)
			version++
		},
	}
	const host: ts.LanguageServiceHost = {
		getCompilationSettings: () => parsed.options,
		getScriptFileNames: () =>
			fileSystem
				.list()
				.filter((path) => /\.[cm]?tsx?$/.test(path))
				.map((path) => '/' + path),
		getScriptVersion: () => String(version),
		getProjectVersion: () => String(version),
		getScriptSnapshot(path) {
			const text = readFile(path)
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
		},
		getCurrentDirectory: () => '/',
		getDefaultLibFileName: (options) =>
			'/.__typescript__/' + ts.getDefaultLibFileName(options),
		readFile,
		fileExists,
		readDirectory,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	}
	const languageService = ts.createLanguageService(host)
	const compilerDiagnostics =
		languageService.getCompilerOptionsDiagnostics.bind(languageService)
	languageService.getCompilerOptionsDiagnostics = () => [
		...parsed.errors,
		...compilerDiagnostics(),
	]
	return { fileSystem: wrapped, languageService }
}
