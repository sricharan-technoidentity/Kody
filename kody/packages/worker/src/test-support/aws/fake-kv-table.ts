export type KvItem = {
	pk: string
	sk: string
	expiresAt?: number
	[key: string]: unknown
}

export function createFakeKvTable(
	options: { userId?: string; now?: () => number } = {},
) {
	const items = new Map<string, KvItem>()
	const now = options.now ?? Date.now
	const check = (pk: string) => {
		if (options.userId && !pk.startsWith(`${options.userId}:`)) {
			throw new Error('cross-user partition key')
		}
	}
	const key = (pk: string, sk: string) => `${pk}\0${sk}`
	const get = (pk: string, sk: string) => {
		check(pk)
		const item = items.get(key(pk, sk))
		if (item && item.expiresAt !== undefined && item.expiresAt <= now()) {
			items.delete(key(pk, sk))
			return undefined
		}
		return item && structuredClone(item)
	}
	return {
		get,
		put(item: KvItem, condition?: (current: KvItem | undefined) => boolean) {
			check(item.pk)
			if (condition && !condition(get(item.pk, item.sk)))
				throw new Error('conditional check failed')
			items.set(key(item.pk, item.sk), structuredClone(item))
		},
		delete(pk: string, sk: string) {
			check(pk)
			items.delete(key(pk, sk))
		},
		update(
			pk: string,
			sk: string,
			update: (current: KvItem | undefined) => KvItem,
			condition?: (current: KvItem | undefined) => boolean,
		) {
			check(pk)
			const current = get(pk, sk)
			if (condition && !condition(current))
				throw new Error('conditional check failed')
			const next = update(current)
			if (next.pk !== pk || next.sk !== sk)
				throw new Error('cannot change item key')
			items.set(key(pk, sk), structuredClone(next))
		},
		query(pk: string, sortPrefix = '') {
			check(pk)
			return [...items.values()]
				.filter((item) => item.pk === pk && item.sk.startsWith(sortPrefix))
				.map((item) => get(item.pk, item.sk))
				.filter((item): item is KvItem => item !== undefined)
				.sort((a, b) => a.sk.localeCompare(b.sk))
		},
	}
}
