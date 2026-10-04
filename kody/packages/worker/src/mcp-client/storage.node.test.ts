import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createFakeTokenVault } from '#worker/test-support/aws/fake-token-vault.ts'
import {
	createMcpClientStorage,
	createImportedMcpCredentialVault,
} from './storage.ts'

test('MCP registrations survive restart, isolate owners and store credentials only in the vault', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	const tokens = createFakeTokenVault(['mcp-client'])
	const vault = createImportedMcpCredentialVault(tokens)
	const alice = await createMcpClientStorage({
		db: database.db,
		userId: 'alice',
		vault,
	})
	alice.sql.exec(
		`INSERT INTO cf_agents_mcp_servers VALUES (?, ?, ?, ?, ?, ?, ?)`,
		'server',
		'Example',
		'https://mcp.example/mcp',
		'https://kody.example/callback',
		null,
		null,
		JSON.stringify({
			transport: { headers: { Authorization: 'Bearer header-secret' } },
		}),
	)
	await alice.put('/Kody/server/client/token', {
		access_token: 'access-secret',
		refresh_token: 'refresh-secret',
	})
	await alice.flush()
	const rows = await database.db
		.prepare('SELECT rows_json FROM mcp_client_hubs')
		.all()
	expect(JSON.stringify(rows)).not.toContain('secret')
	const values = await database.db
		.prepare('SELECT value_json FROM mcp_client_values')
		.all()
	expect(JSON.stringify(values)).not.toContain('secret')
	const restored = await createMcpClientStorage({
		db: database.db,
		userId: 'alice',
		vault,
	})
	expect(await restored.get('/Kody/server/client/token')).toEqual({
		access_token: 'access-secret',
		refresh_token: 'refresh-secret',
	})
	expect(
		[...restored.sql.exec('SELECT * FROM cf_agents_mcp_servers')][0]
			?.server_options,
	).toContain('header-secret')
	await expect(
		createMcpClientStorage({ db: database.db, userId: 'bob', vault }),
	).rejects.toThrow('owner mismatch')
	const bob = await createMcpClientStorage({
		db: database.forUser('bob').db,
		userId: 'bob',
		vault,
	})
	expect([...bob.sql.exec('SELECT * FROM cf_agents_mcp_servers')]).toEqual([])
	expect(await bob.get('/Kody/server/client/token')).toBeUndefined()
	await bob.deleteAll()
	expect(await alice.get('/Kody/server/client/token')).toBeTruthy()
	await restored.deleteAll()
	expect(await restored.get('/Kody/server/client/token')).toBeUndefined()
	alice.close()
	restored.close()
	bob.close()
})
