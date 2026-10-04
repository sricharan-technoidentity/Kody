import { readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type DemoState = {
	origin: string
	token: string
	pid: number
	temporalUi: string
}
const statePath = join(
	tmpdir(),
	`kody-demo-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
export async function readDemoState(): Promise<DemoState> {
	try {
		return JSON.parse(await readFile(statePath, 'utf8'))
	} catch {
		throw new Error('Start npm run demo in another terminal first.')
	}
}
export async function acquireDemoLock(token: string) {
	const lockPath = `${statePath}.lock`
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), {
				mode: 0o600,
				flag: 'wx',
			})
			return
		} catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') throw error
			const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
				pid: number
			}
			try {
				process.kill(lock.pid, 0)
			} catch (error) {
				if ((error as { code?: string }).code === 'ESRCH') {
					await rm(lockPath, { force: true })
					continue
				}
				throw new Error('An existing demo session owns this workspace.')
			}
			throw new Error(
				'A demo is already running for this workspace. Use demo:run or demo:reset.',
			)
		}
	}
	throw new Error('Could not acquire the demo session lock.')
}
export async function writeDemoState(state: DemoState) {
	await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
}
export async function clearDemoState(token: string) {
	for (const path of [statePath, `${statePath}.lock`]) {
		try {
			const existing = JSON.parse(await readFile(path, 'utf8')) as {
				token: string
			}
			if (existing.token === token) await rm(path, { force: true })
		} catch (error) {
			if ((error as { code?: string }).code !== 'ENOENT') throw error
		}
	}
}
export async function demoControl(path: string, data?: unknown) {
	const state = await readDemoState()
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin))
		throw new Error('Invalid local demo origin.')
	const response = await fetch(`${state.origin}/__demo/${path}`, {
		method: data === undefined ? 'GET' : 'POST',
		headers: {
			Authorization: `Bearer ${state.token}`,
			'content-type': 'application/json',
		},
		body: data === undefined ? undefined : JSON.stringify(data),
		signal: AbortSignal.timeout(180000),
	})
	if (!response.ok)
		throw new Error(
			`Demo ${path} failed: HTTP ${response.status} ${await response.text()}`,
		)
	return response.json()
}
