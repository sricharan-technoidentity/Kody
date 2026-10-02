export type CheckName = 'bundle' | 'typecheck' | 'lint'

/** Where a passing `bundle` check leaves its output in the session. */
export const bundleOutputPath = 'dist/bundle.js'

export function createFakeCodeInterpreter() {
	const files = new Map<string, Uint8Array>()
	const results = new Map<CheckName, { ok: boolean; output: string }>()
	const calls: CheckName[] = []
	return {
		files,
		calls,
		writeFile(path: string, contents: Uint8Array) {
			files.set(path, contents.slice())
		},
		readFile(path: string) {
			return files.get(path)?.slice()
		},
		respondWith(check: CheckName, result: { ok: boolean; output: string }) {
			results.set(check, result)
		},
		async run(check: CheckName) {
			calls.push(check)
			const result = results.get(check)
			if (!result) throw new Error(`no scripted ${check} result`)
			if (check === 'bundle' && result.ok) {
				files.set(bundleOutputPath, new TextEncoder().encode(result.output))
			}
			return result
		},
	}
}
