import { readFile, access, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isExecutedDirectly } from '#tools/node-runtime.ts'

export async function checkPocDocs() {
	const files = [
		'README.md',
		'AGENTS.md',
		'planss/kody-migration-plan.md',
		...(await readdir('docs/poc'))
			.filter((file) => file.endsWith('.md'))
			.map((file) => `docs/poc/${file}`),
		...[
			'index',
			'local-development',
			'checks',
			'seeding',
			'preview-deploys',
			'migrations',
		].map((file) => `docs/contributing/setup/${file}.md`),
		...[
			'index',
			'authentication',
			'data-storage',
			'run-records',
			'integrations',
			'mcp-client-servers',
			'request-lifecycle',
			'jobs-worker-migration-runbook',
		].map((file) => `docs/contributing/architecture/${file}.md`),
		'docs/contributing/getting-started.md',
		'docs/contributing/setup-manifest.md',
		'docs/contributing/environment-variables.md',
		'docs/contributing/cloud-agents.md',
		'docs/contributing/packages-and-manifests.md',
		'docs/use/email-primitives.md',
	]
	const scripts = (
		JSON.parse(await readFile('package.json', 'utf8')) as {
			scripts: Record<string, string>
		}
	).scripts
	const issues: Array<string> = []
	for (const file of files) {
		const text = await readFile(file, 'utf8')
		for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			const link = match[1]!
			if (/^(?:https?:|mailto:|#|app:|codex:)/.test(link)) continue
			const path = decodeURIComponent(link.split('#')[0]!)
			try {
				await access(resolve(dirname(file), path))
			} catch {
				issues.push(`${file}: missing ${path}`)
			}
		}
		for (const match of text.matchAll(/npm run ([a-z][\w:-]*)/g))
			if (!scripts[match[1]!])
				issues.push(`${file}: missing script ${match[1]}`)
	}
	for (const name of [
		'dev',
		'demo',
		'demo:run',
		'demo:reset',
		'demo:check',
		'demo:aws:check',
	]) {
		const entry = scripts[name]?.match(/tools\/demo\/[\w-]+\.ts/)?.[0]
		if (!entry) issues.push(`Script ${name} must use tools/demo`)
		else
			try {
				await access(entry)
			} catch {
				issues.push(`Missing entry ${entry}`)
			}
	}
	return { files: files.length, issues }
}
if (isExecutedDirectly(import.meta.url))
	void checkPocDocs().then((result) => {
		if (result.issues.length) {
			console.error(result.issues.join('\n'))
			process.exitCode = 1
		} else console.info(`POC links/scripts: ${result.files} pages passed.`)
	})
