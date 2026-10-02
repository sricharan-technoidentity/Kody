import { expect, test } from 'vitest'
import { createTargetTestEnv } from './target-test-env.ts'

test('target environment gives one user a working database and isolated stores', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		env.kv.put({ pk: 'alice:meter', sk: 'today', amount: 1 })
		expect(env.kv.get('alice:meter', 'today')?.amount).toBe(1)
		expect(() => env.objects.get('bob/private')).toThrow('cross-user')
		await env.APP_DB.prepare(
			"INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('memory', 'alice', 'garden', 'notes')",
		).run()
		expect(
			await env.APP_DB_READER.prepare('SELECT subject FROM mcp_memories').first(
				'subject',
			),
		).toBe('garden')
		await env.AUDIT_DB.prepare(
			"INSERT INTO audit_events (category, action, result, timestamp) VALUES ('auth', 'login', 'success', '2026-09-30T00:00:00.000Z')",
		).run()
		expect(
			await env.AUDIT_DB_READER.prepare(
				'SELECT action FROM audit_events',
			).first('action'),
		).toBe('login')
		await expect(
			env.APP_DB.prepare('SELECT * FROM audit_events').all(),
		).rejects.toThrow('does not exist')
		const [values] = await env.BEDROCK_EMBEDDINGS.embedTexts(['garden notes'])
		await env.SEARCH_INDEX.upsert([
			{
				id: 'memory',
				values: values!,
				text: 'garden notes',
				metadata: { kind: 'memory', userId: 'alice' },
			},
		])
		expect(
			(await env.SEARCH_INDEX.query(values!, { topK: 1 })).matches[0]?.id,
		).toBe('memory')
		expect(
			(await env.reader.prepare('SELECT 1 AS value').first<{ value: number }>())
				?.value,
		).toBe(1)
	} finally {
		await close()
	}
})
