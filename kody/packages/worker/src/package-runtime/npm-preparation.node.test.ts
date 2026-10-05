import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { afterEach, expect, test, vi } from 'vitest'
import { createWorker } from './package-build-tools.ts'
import { prepareNpmFiles } from './npm-preparation.ts'

afterEach(() => vi.unstubAllGlobals())

async function registry(
	path = 'package/index.js',
	integrityValid = true,
	type = 'file',
) {
	const archive = pack()
	archive.entry(
		{ name: 'package/package.json' },
		JSON.stringify({ name: 'fresh', version: '1.0.0', main: './index.js' }),
	)
	archive.entry(
		{ name: path, type, linkname: '/etc/passwd' },
		type === 'file' ? 'export default 42' : undefined,
	)
	archive.finalize()
	const chunks: Array<Buffer> = []
	for await (const chunk of archive) chunks.push(Buffer.from(chunk))
	const bytes = gzipSync(Buffer.concat(chunks))
	const fetch = vi.fn(async (url: URL) =>
		url.pathname.endsWith('.tgz')
			? new Response(bytes)
			: Response.json({
					'dist-tags': { latest: '1.0.0' },
					versions: {
						'1.0.0': {
							version: '1.0.0',
							dist: {
								tarball: 'https://registry.npmjs.org/fresh.tgz',
								integrity: `sha512-${integrityValid ? createHash('sha512').update(bytes).digest('base64') : 'wrong'}`,
							},
						},
					},
				}),
	)
	vi.stubGlobal('fetch', fetch)
	return fetch
}

const files = {
	'package.json': JSON.stringify({
		dependencies: { fresh: '^1.0.0' },
		scripts: { postinstall: 'touch /tmp/never-run-this' },
	}),
	'entry.ts': "import answer from 'fresh'; export default answer",
}

test('fresh registry preparation verifies integrity and bundles without install scripts or disk extraction', async () => {
	const fetch = await registry()
	const bundle = await createWorker({ files, entryPoint: 'entry.ts' })
	const module = await import(
		`data:application/javascript;base64,${Buffer.from(bundle.modules[bundle.mainModule]!).toString('base64')}`
	)
	expect(module.default).toBe(42)
	expect(fetch).toHaveBeenCalledTimes(2)
	const prepared = await prepareNpmFiles(files)
	fetch.mockClear()
	await prepareNpmFiles(prepared)
	expect(fetch).not.toHaveBeenCalled()
})

test('registry preparation denies traversal, symlinks, bad integrity, host specs and cancelled work', async () => {
	for (const [path, integrity, type] of [
		['package/../../escape.js', true, 'file'],
		['package/link.js', true, 'symlink'],
		['package/index.js', false, 'file'],
	] as const) {
		await registry(path, integrity, type)
		await expect(prepareNpmFiles(files)).rejects.toThrow(/archive|integrity/)
	}
	const fetch = await registry()
	await expect(
		prepareNpmFiles({
			'package.json': '{"dependencies":{"fresh":"file:/etc"}}',
		}),
	).rejects.toThrow('Unsupported registry dependency')
	const controller = new AbortController()
	controller.abort(new Error('Cancelled'))
	await expect(
		prepareNpmFiles(files, { signal: controller.signal }),
	).rejects.toThrow('Cancelled')
	expect(fetch).not.toHaveBeenCalled()
})
