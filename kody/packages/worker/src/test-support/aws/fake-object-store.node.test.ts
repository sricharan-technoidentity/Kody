import { expect, test } from 'vitest'
import { createFakeObjectStore } from './fake-object-store.ts'

test('object store copies bytes and rejects another user prefix', () => {
	const store = createFakeObjectStore({ userId: 'alice' })
	const bytes = new Uint8Array([1, 2])
	store.put('alice/a', bytes)
	bytes[0] = 9
	expect(store.get('alice/a')).toEqual(new Uint8Array([1, 2]))
	expect(store.list('alice/')).toEqual(['alice/a'])
	expect(() => store.put('bob/a', bytes)).toThrow('cross-user')
})
