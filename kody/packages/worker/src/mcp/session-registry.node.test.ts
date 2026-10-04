import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { listMcpAgentSessionsForUser } from './session-registry.ts'

test('legacy session inventory is owner scoped on PostgreSQL', async () => {
	await using fixture = await createTestDb({ userId: 'user-a' })
	await fixture.pg.query(
		`INSERT INTO mcp_agent_sessions (do_id, user_id) VALUES ('do-a', 'user-a'), ('do-b', 'user-b')`,
	)
	expect(await listMcpAgentSessionsForUser(fixture.db, 'user-a')).toEqual([
		{ doId: 'do-a' },
	])
	expect(await listMcpAgentSessionsForUser(fixture.db, 'user-b')).toEqual([])
	expect(
		await listMcpAgentSessionsForUser(fixture.forUser('user-b').db, 'user-b'),
	).toEqual([{ doId: 'do-b' }])
})
