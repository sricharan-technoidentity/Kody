import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createDiskAssets } from './assets.ts'

test('disk assets serve binary files and HEAD, and deny traversal and escaping symlinks', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'kody-assets-'))
	try {
		const root = join(directory, 'public')
		await mkdir(root)
		await writeFile(join(root, 'image.png'), new Uint8Array([0, 255, 128]))
		await writeFile(join(directory, 'private.txt'), 'private')
		await symlink(join(directory, 'private.txt'), join(root, 'escape.txt'))
		const assets = createDiskAssets(root)
		const response = await assets.fetch(
			new Request('https://kody.codes/image.png'),
		)
		expect(response.headers.get('Content-Type')).toBe('image/png')
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array([0, 255, 128]),
		)
		expect(
			await (
				await assets.fetch(
					new Request('https://kody.codes/image.png', { method: 'HEAD' }),
				)
			).text(),
		).toBe('')
		for (const path of ['/missing', '/%2e%2e%2fprivate.txt', '/escape.txt'])
			expect(
				(await assets.fetch(new Request(`https://kody.codes${path}`))).status,
			).toBe(404)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
