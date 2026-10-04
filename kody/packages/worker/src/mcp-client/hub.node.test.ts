import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createFakeTokenVault } from '#worker/test-support/aws/fake-token-vault.ts'
import { createMcpClients } from './service.ts'
import { createImportedMcpCredentialVault } from './storage.ts'

test('hub restores remote clients on Node using Aurora registrations', async () => {
	await using database = await createTestDb({ userId: 'owner' })
	const clients = createMcpClients({
		forUser: (userId) => database.forUser(userId).db,
		vault: createImportedMcpCredentialVault(
			createFakeTokenVault(['mcp-client']),
		),
	})
	const hub = clients.forUser('owner')
	expect(await hub.getSnapshot()).toEqual({ servers: [], connectionEvents: [] })
	expect(await hub.peekServers()).toEqual({ servers: [] })
	await hub.removeServer({ serverId: 'missing' })
	expect((await hub.getSnapshot()).servers).toEqual([])
})
