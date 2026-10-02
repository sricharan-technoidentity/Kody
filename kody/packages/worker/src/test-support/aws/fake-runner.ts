export type RunnerInvocation = { runtimeSessionId: string; payload: unknown }

export function createFakeRunner() {
	const invocations: RunnerInvocation[] = []
	const responses: unknown[] = []
	return {
		invocations,
		respondWith(value: unknown) {
			responses.push(value)
		},
		async invoke(input: RunnerInvocation) {
			invocations.push(structuredClone(input))
			if (responses.length === 0) throw new Error('no scripted Runner response')
			return responses.shift()
		},
	}
}
