import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The same installed sources a publish workspace supplies; no registry traffic in compatibility tests. */
export async function installedKleurFiles() {
	const root = dirname(createRequire(import.meta.url).resolve('kleur'))
	const names = [
		'package.json',
		'index.js',
		'index.mjs',
		'colors.js',
		'colors.mjs',
	]
	return Object.fromEntries(
		await Promise.all(
			names.map(async (name) => [
				`node_modules/kleur/${name}`,
				await readFile(join(root, name), 'utf8'),
			]),
		),
	)
}
