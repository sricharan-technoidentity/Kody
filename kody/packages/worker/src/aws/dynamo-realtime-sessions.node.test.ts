import { expect, test } from 'vitest'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createDynamoRealtimeSessions } from './dynamo-realtime-sessions.ts'

test('realtime session state isolates owner/package keys, filters expired records and supports disconnect/purge', async () => {
	const dynamo = createFakeDynamo()
	let now = 1000
	const store = createDynamoRealtimeSessions({
		region: 'us-east-1',
		tableName: 'realtime',
		send: dynamo.send,
		now: () => now,
	})
	const key = { userId: 'alice', packageId: 'package' }
	const session = {
		id: 'session',
		facet: 'main',
		topics: ['events'],
		connectedAt: '2026-10-02',
		lastSeenAt: '2026-10-02',
	}
	await store.put(key, session)
	expect(await store.list(key)).toEqual([session])
	expect(await store.list({ ...key, userId: 'bob' })).toEqual([])
	expect(await store.list({ ...key, packageId: 'other' })).toEqual([])
	await store.remove({ ...key, userId: 'bob' }, 'session')
	expect(await store.list(key)).toHaveLength(1)
	await store.purge(key)
	expect(await store.list(key)).toEqual([])
	await store.put(key, session)
	now += 86_400_000
	expect(await store.list(key)).toEqual([])
})
