import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const statePath = join(
	tmpdir(),
	`kody-poc-e2e-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
export function readE2ePocState(): { origin: string; token: string } {
	return JSON.parse(readFileSync(statePath, 'utf8'))
}
export async function writeE2ePocState(state: {
	origin: string
	token: string
}) {
	await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
}
export async function pocControl(path: string, data?: unknown) {
	const state = readE2ePocState()
	const response = await fetch(new URL(`/__poc/${path}`, state.origin), {
		method: data === undefined ? 'GET' : 'POST',
		headers: {
			Authorization: `Bearer ${state.token}`,
			'Content-Type': 'application/json',
		},
		body: data === undefined ? undefined : JSON.stringify(data),
	})
	if (!response.ok)
		throw new Error(`POC control ${path} failed: ${await response.text()}`)
	return response.json()
}
