import { expect, test } from 'vitest'
import { createFakeTokenVault } from './fake-token-vault.ts'

test('Identity vault scopes tokens by user, provider and workload', () => {
	const vault = createFakeTokenVault(['egress'])
	vault.store('alice', 'github', 'alice-token')
	expect(vault.fetch('alice', 'github', 'egress')).toBe('alice-token')
	expect(vault.fetch('bob', 'github', 'egress')).toBeUndefined()
	expect(() => vault.fetch('alice', 'github', 'runner')).toThrow('workload')
})
