import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const exec = promisify(execFile)

/** A synthetic local Git remote. All Git writes are confined to this temporary fixture. */
export async function createSourceFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'kody-demo-source-'))
	const work = join(directory, 'work')
	const bare = join(directory, 'test/demo-report.git')
	try {
		await mkdir(work)
		await mkdir(join(directory, 'test'))
		await writeFile(
			join(work, 'package.json'),
			JSON.stringify({
				name: '@alice/report',
				private: true,
				exports: { '.': './report.ts', './app': './app.ts' },
				kody: {
					id: 'report',
					description: 'Synthetic POC report',
					app: { entry: './app.ts' },
					webhooks: [
						{
							name: 'report',
							export: '.',
							responseMode: 'sync',
							inputMode: 'params',
						},
					],
					jobs: {
						report: {
							entry: './report.ts',
							schedule: { type: 'interval', every: '1h' },
							enabled: false,
						},
					},
				},
			}),
		)
		await writeFile(
			join(work, 'report.ts'),
			`import { packageStorage } from 'kody:runtime';\nexport default async function report(input: { label?: string } = {}) {\n  const storage = packageStorage();\n  await storage.sql('CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, label TEXT)');\n  await storage.sql('INSERT INTO reports (label) VALUES (?)', [input.label ?? 'POC report']);\n  const rows = await storage.sql('SELECT id, label FROM reports ORDER BY id');\n  console.log('Report stored');\n  return rows;\n}\n`,
		)
		await writeFile(
			join(work, 'app.ts'),
			`export default async function app() { return new Response('POC report v1', { headers: { 'content-type': 'text/plain' } }); }\n`,
		)
		await writeFile(
			join(work, 'README.md'),
			'# Report\n\n## Intent\n\nStore synthetic POC reports.\n',
		)
		await writeFile(
			join(work, 'AGENTS.md'),
			'# Report agent notes\n\nUse the default callable export with a synthetic label.\n',
		)
		await exec('git', ['init', '--initial-branch=main', work])
		await exec('git', ['-C', work, 'add', '.'])
		await exec('git', [
			'-C',
			work,
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'user.name=POC Fixture',
			'-c',
			'user.email=poc@example.invalid',
			'commit',
			'-m',
			'Synthetic POC report',
		])
		await exec('git', ['clone', '--bare', work, bare])
		await exec('git', ['--git-dir', bare, 'config', 'http.receivepack', 'true'])
		const files = Object.fromEntries(
			await Promise.all(
				['package.json', 'report.ts', 'app.ts', 'README.md', 'AGENTS.md'].map(
					async (name) => [name, await readFile(join(work, name), 'utf8')],
				),
			),
		) as Record<string, string>
		const commit = (
			await exec('git', ['--git-dir', bare, 'rev-parse', 'HEAD'])
		).stdout.trim()
		return {
			directory,
			commit,
			files,
			async fetch(request: Request): Promise<Response | undefined> {
				const url = new URL(request.url)
				if (!url.pathname.startsWith('/git/')) return undefined
				const path = decodeURIComponent(url.pathname.slice(4))
				if (
					!/^\/test\/demo-report\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(
						path,
					)
				)
					return new Response(null, { status: 404 })
				const body = Buffer.from(await request.arrayBuffer())
				const child = spawn('git', ['http-backend'], {
					env: {
						...process.env,
						GIT_PROJECT_ROOT: directory,
						GIT_HTTP_EXPORT_ALL: '1',
						PATH_INFO: path,
						REQUEST_METHOD: request.method,
						QUERY_STRING: url.search.slice(1),
						CONTENT_TYPE: request.headers.get('content-type') ?? '',
						CONTENT_LENGTH: String(body.length),
						REMOTE_USER: 'demo',
						REMOTE_ADDR: '127.0.0.1',
					},
					stdio: ['pipe', 'pipe', 'pipe'],
				})
				const chunks: Array<Buffer> = []
				let diagnostics = ''
				child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
				child.stderr.on('data', (chunk: Buffer) => {
					diagnostics += chunk.toString()
				})
				child.stdin.end(body)
				const [code] = await once(child, 'close')
				if (code) throw new Error(`Local Git fixture failed: ${diagnostics}`)
				const output = Buffer.concat(chunks)
				const split = output.indexOf('\r\n\r\n')
				if (split < 0)
					throw new Error('Local Git fixture returned invalid CGI headers.')
				const headers = new Headers()
				let status = 200
				for (const line of output.subarray(0, split).toString().split('\r\n')) {
					const colon = line.indexOf(':')
					const key = line.slice(0, colon)
					const value = line.slice(colon + 1).trim()
					if (key.toLowerCase() === 'status')
						status = Number(value.split(' ')[0])
					else headers.append(key, value)
				}
				return new Response(output.subarray(split + 4), { status, headers })
			},
			async close() {
				await rm(directory, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true })
		throw error
	}
}
