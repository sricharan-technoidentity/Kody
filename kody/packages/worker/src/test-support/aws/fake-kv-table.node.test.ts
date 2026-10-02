import { expect, test } from 'vitest'
import { createFakeKvTable } from './fake-kv-table.ts'

test('KV enforces partition ownership, conditional updates, prefix queries and TTL', () => {
	let now = 100
	const table = createFakeKvTable({ userId: 'alice', now: () => now })
	table.put({ pk: 'alice:runs', sk: '001', count: 1, expiresAt: 200 })
	expect(table.query('alice:runs', '00')).toHaveLength(1)
	table.update('alice:runs', '001', (item) => ({ ...item!, count: 2 }))
	expect(table.get('alice:runs', '001')?.count).toBe(2)
	expect(() => table.put({ pk: 'alice:runs', sk: '001' }, () => false)).toThrow(
		'conditional',
	)
	expect(() =>
		table.update(
			'alice:runs',
			'001',
			(item) => item!,
			() => false,
		),
	).toThrow('conditional')
	expect(() => table.get('bob:runs', '001')).toThrow('cross-user')
	now = 200
	expect(table.get('alice:runs', '001')).toBeUndefined()
})
