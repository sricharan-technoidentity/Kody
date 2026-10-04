import { expect, test } from 'vitest'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createDynamoLeases } from './dynamo-leases.ts'

test('storage leases cannot be stolen while live, renew only their owner and monotonically fence takeover', async () => {
	let now = 1000
	const leases = createDynamoLeases({
		region: 'us-east-1',
		tableName: 'leases',
		send: createFakeDynamo().send,
		now: () => now,
		durationMs: 100,
	})
	const key = { userId: 'alice', storageId: 'package:pkg' }
	const first = await leases.acquire({ ...key, ownerId: 'one' })
	await expect(leases.acquire({ ...key, ownerId: 'two' })).rejects.toThrow(
		'lease',
	)
	expect((await leases.acquire({ ...key, ownerId: 'one' })).fencingToken).toBe(
		first.fencingToken,
	)
	now = 1200
	const second = await leases.acquire({ ...key, ownerId: 'two' })
	expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
	await expect(leases.assert({ ...key, ...first })).rejects.toThrow('lease')
	await leases.assert({ ...key, ...second })
	await expect(
		leases.assert({ ...key, userId: 'bob', ...second }),
	).rejects.toThrow('lease')
})
