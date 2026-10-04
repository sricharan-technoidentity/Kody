import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { checkCloudflareReferences } from './check-cloudflare-references.ts'

test('the reference gate requires exact entries, reasons and removal of stale exceptions', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'kody-reference-gate-'))
	try {
		for (const directory of ['packages', 'e2e', 'tools'])
			mkdirSync(path.join(root, directory))
		writeFileSync(
			path.join(root, 'packages/compat.ts'),
			'type Cache = KVNamespace',
		)
		writeFileSync(
			path.join(root, 'tools/native.ts'),
			'export const native = true',
		)
		mkdirSync(path.join(root, 'packages/node_modules'))
		writeFileSync(
			path.join(root, 'packages/node_modules/vendor.ts'),
			'DurableObject',
		)
		expect(
			checkCloudflareReferences(root, [
				{
					file: 'packages/compat.ts',
					reason: 'Portable cache adapter contract.',
				},
			]),
		).toEqual({ count: 1, errors: [] })
		expect(
			checkCloudflareReferences(root, [{ file: 'packages/*', reason: '' }])
				.errors,
		).toEqual([
			'Missing reason: packages/*',
			'Stale entry: packages/*',
			'Unallowlisted reference: packages/compat.ts',
		])
		writeFileSync(
			path.join(root, 'packages/compat.ts'),
			'export const migrated = true',
		)
		expect(
			checkCloudflareReferences(root, [
				{ file: 'packages/compat.ts', reason: 'Old exception' },
			]).errors,
		).toEqual(['Stale entry: packages/compat.ts'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
