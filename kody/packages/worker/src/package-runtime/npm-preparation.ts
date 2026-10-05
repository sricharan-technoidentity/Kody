import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extract } from 'tar-stream'
import { maxSatisfying, satisfies, validRange } from 'semver'

const maxBytes = 64 * 1024 * 1024
type Manifest = {
	name: string
	version: string
	dependencies?: Record<string, string>
	dist?: { tarball: string; integrity?: string; shasum?: string }
}

/** Trusted preparation only: registry bytes become virtual files, never executable install scripts. */
export async function prepareNpmFiles(
	files: Record<string, string>,
	input: { registry?: string; signal?: AbortSignal } = {},
) {
	const registry = new URL(input.registry ?? 'https://registry.npmjs.org/')
	if (registry.protocol !== 'https:' || registry.username || registry.password)
		throw new Error('Dependency preparation requires a trusted HTTPS registry.')
	const signal = AbortSignal.any([
		AbortSignal.timeout(30_000),
		...(input.signal ? [input.signal] : []),
	])
	const prepared = { ...files }
	let packages = 0
	let count = 0
	let total = 0
	async function bytes(url: URL) {
		if (url.origin !== registry.origin)
			throw new Error('Dependency URL escapes the trusted registry.')
		const response = await fetch(url, { signal, redirect: 'error' })
		if (!response.ok)
			throw new Error(`Dependency registry returned ${response.status}.`)
		const chunks: Array<Buffer> = []
		let size = 0
		if (response.body)
			for await (const chunk of response.body) {
				size += chunk.length
				if (size > 16 * 1024 * 1024)
					throw new Error('Dependency download limit exceeded.')
				chunks.push(Buffer.from(chunk))
			}
		return Buffer.concat(chunks)
	}
	async function install(name: string, range: string, directory: string) {
		signal.throwIfAborted()
		if (
			!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
			name === '.' ||
			name === '..'
		)
			throw new Error('Invalid dependency name.')
		if (
			typeof range !== 'string' ||
			(!validRange(range) && !/^[a-z][\w.-]*$/i.test(range))
		)
			throw new Error(`Unsupported registry dependency: ${name}@${range}`)
		// Captured published dependencies are authoritative and need no registry request.
		for (let parent = directory; ; parent = posix.dirname(parent)) {
			const existing =
				prepared[posix.join(parent, 'node_modules', name, 'package.json')]
			if (existing) {
				const version = (JSON.parse(existing) as Manifest).version
				if (
					parent === directory ||
					!validRange(range) ||
					satisfies(version, range)
				)
					return
			}
			if (parent === '.') break
		}
		if (++packages > 300) throw new Error('Dependency package limit exceeded.')
		const metadata = JSON.parse(
			(await bytes(new URL(encodeURIComponent(name), registry))).toString(),
		) as {
			versions: Record<string, Manifest>
			'dist-tags': Record<string, string>
		}
		const version =
			metadata['dist-tags'][range] ??
			maxSatisfying(Object.keys(metadata.versions), range)
		const manifest = version ? metadata.versions[version] : undefined
		if (!manifest?.dist)
			throw new Error(`Cannot resolve registry dependency: ${name}@${range}`)
		const archive = await bytes(new URL(manifest.dist.tarball))
		const integrity = manifest.dist.integrity
			?.split(/\s+/)
			.find((value) => /^sha(256|384|512)-/.test(value))
		const [algorithm, expected] = integrity?.split('-', 2) ?? [
			'sha1',
			manifest.dist.shasum,
		]
		if (
			!expected ||
			createHash(algorithm!)
				.update(archive)
				.digest(integrity ? 'base64' : 'hex') !== expected
		)
			throw new Error('Dependency tarball integrity mismatch.')
		const root = posix.join(directory, 'node_modules', name)
		const parser = extract()
		parser.on('entry', (header, stream, next) => {
			void (async () => {
				if (header.type === 'directory') {
					stream.resume()
					next()
					return
				}
				if (header.type !== 'file' || !header.name.startsWith('package/'))
					throw new Error('Unsupported dependency archive entry.')
				const path = header.name.slice('package/'.length)
				if (
					!path ||
					path.includes('\\') ||
					path.startsWith('/') ||
					path.split('/').some((part) => part === '..' || part === '.') ||
					path.includes('\0')
				)
					throw new Error('Dependency archive path escapes package.')
				if (++count > 20_000 || (total += header.size) > maxBytes)
					throw new Error('Dependency workspace limit exceeded.')
				const chunks: Array<Buffer> = []
				for await (const chunk of stream) chunks.push(Buffer.from(chunk))
				prepared[posix.join(root, path)] =
					Buffer.concat(chunks).toString('utf8')
				next()
			})().catch((error: unknown) =>
				parser.destroy(
					error instanceof Error ? error : new Error(String(error)),
				),
			)
		})
		await pipeline(
			Readable.from([gunzipSync(archive, { maxOutputLength: maxBytes })]),
			parser,
			{ signal },
		)
		if (!prepared[`${root}/package.json`])
			throw new Error('Dependency archive has no package.json.')
		for (const [dependency, constraint] of Object.entries(
			manifest.dependencies ?? {},
		))
			await install(dependency, constraint, root)
	}
	// Root and rewritten workspace manifests share this preparation path.
	for (const [path, text] of Object.entries(files)) {
		if (
			posix.basename(path) !== 'package.json' ||
			path.split('/').includes('node_modules')
		)
			continue
		const manifest = JSON.parse(text) as Manifest
		for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
			await install(name, range, posix.dirname(path))
	}
	return prepared
}
