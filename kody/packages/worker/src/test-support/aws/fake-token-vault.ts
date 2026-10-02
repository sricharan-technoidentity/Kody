export function createFakeTokenVault(allowedWorkloads: readonly string[]) {
	const tokens = new Map<string, string>()
	const key = (userId: string, provider: string) => `${userId}\0${provider}`
	return {
		store(userId: string, provider: string, token: string) {
			tokens.set(key(userId, provider), token)
		},
		fetch(userId: string, provider: string, workload: string) {
			if (!allowedWorkloads.includes(workload))
				throw new Error('workload not allowed')
			return tokens.get(key(userId, provider))
		},
	}
}
