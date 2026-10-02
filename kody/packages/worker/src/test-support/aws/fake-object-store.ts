export function createFakeObjectStore(options: { userId?: string } = {}) {
	const objects = new Map<string, Uint8Array>()
	const check = (key: string) => {
		if (options.userId && !key.startsWith(`${options.userId}/`)) {
			throw new Error('cross-user object key')
		}
	}
	return {
		get(key: string) {
			check(key)
			const value = objects.get(key)
			return value && value.slice()
		},
		put(key: string, value: Uint8Array) {
			check(key)
			objects.set(key, value.slice())
		},
		delete(key: string) {
			check(key)
			objects.delete(key)
		},
		list(prefix: string) {
			check(prefix)
			return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
		},
	}
}
