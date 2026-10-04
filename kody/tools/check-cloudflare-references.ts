import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

const referencePattern =
	/cloudflare:|D1Database|DurableObject|idFromName|KVNamespace|R2Bucket|wrangler|WorkflowEntrypoint/
type AllowlistEntry = { file: string; reason: string }

export function checkCloudflareReferences(
	root: string,
	entries: AllowlistEntry[],
) {
	const references = new Set<string>()
	function scan(directory: string) {
		for (const entry of readdirSync(path.join(root, directory), {
			withFileTypes: true,
		})) {
			if (entry.name === 'node_modules') continue
			const relative = `${directory}/${entry.name}`
			if (entry.isDirectory()) scan(relative)
			else if (
				entry.isFile() &&
				/\.tsx?$/.test(entry.name) &&
				referencePattern.test(readFileSync(path.join(root, relative), 'utf8'))
			)
				references.add(relative)
		}
	}
	for (const directory of ['packages', 'e2e', 'tools']) scan(directory)
	const allowed = new Set<string>()
	const errors: string[] = []
	for (const entry of entries) {
		if (!entry.reason.trim()) errors.push(`Missing reason: ${entry.file}`)
		if (allowed.has(entry.file)) errors.push(`Duplicate entry: ${entry.file}`)
		allowed.add(entry.file)
		if (!references.has(entry.file)) errors.push(`Stale entry: ${entry.file}`)
	}
	for (const file of references) {
		if (!allowed.has(file)) errors.push(`Unallowlisted reference: ${file}`)
	}
	return { count: references.size, errors: errors.sort() }
}

if (isExecutedDirectly(import.meta.url)) {
	const root = path.resolve(import.meta.dirname, '..')
	const entries = JSON.parse(
		readFileSync(
			path.join(root, 'docs/migration/cloudflare-reference-allowlist.json'),
			'utf8',
		),
	) as AllowlistEntry[]
	const result = checkCloudflareReferences(root, entries)
	if (result.errors.length) {
		console.error(result.errors.join('\n'))
		process.exitCode = 1
	} else
		console.log(
			`Cloudflare reference gate: ${result.count} explicitly documented files.`,
		)
}
