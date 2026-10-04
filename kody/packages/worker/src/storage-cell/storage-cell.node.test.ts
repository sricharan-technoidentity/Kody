import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { openStorageCell } from './storage-cell.ts'

test('storage SQL preserves its API while fencing stale leases and reserving bytes', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		env.kv.put({
			pk: 'alice:meters',
			sk: 'storage_bytes',
			remaining: 1_000_000,
		})
		const input = {
			env,
			userId: 'alice',
			storageId: 'package:pkg',
			ownerId: 'worker-1',
		}
		const first = await openStorageCell(input)
		await first.sql('CREATE TABLE items (value TEXT)')
		await first
			.sql(
				"CREATE TABLE batch(value TEXT); INSERT INTO batch VALUES ('semi;colon'); SELECT value FROM batch",
			)
			.then((rows) => expect(rows).toEqual([['semi;colon']]))
		await expect(
			first.sql(
				"INSERT INTO batch VALUES ('rollback'); INSERT INTO missing VALUES (1)",
			),
		).rejects.toThrow()
		expect(await first.sql('SELECT COUNT(*) FROM batch')).toEqual([[1]])
		await first.sql('INSERT INTO items VALUES (?)', ['hello'])
		expect(await first.sql('SELECT value FROM items')).toEqual([['hello']])
		await expect(
			first.sql("ATTACH DATABASE '/tmp/other-user.sqlite' AS other"),
		).rejects.toThrow()
		await expect(first.sql('BEGIN')).rejects.toThrow()
		await expect(
			openStorageCell({ ...input, ownerId: 'worker-2' }),
		).rejects.toThrow('lease')
		await first.release()
		const second = await openStorageCell({ ...input, ownerId: 'worker-2' })
		expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
		await expect(
			first.sql('INSERT INTO items VALUES (?)', ['stale']),
		).rejects.toThrow('lease')
		await second.sql(
			'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1001) INSERT INTO items SELECT CAST(n AS TEXT) FROM seq',
		)
		expect(
			(await second.sql('SELECT value FROM items')).length,
		).toBeLessThanOrEqual(1_000)
		expect(env.kv.get('alice:meters', 'storage_bytes')?.remaining).toBeLessThan(
			1_000_000,
		)
		env.kv.update('alice:meters', 'storage_bytes', (item) => ({
			...item!,
			remaining: 0,
		}))
		await expect(
			second.sql('INSERT INTO items VALUES (?)', ['over-limit']),
		).rejects.toThrow('entitlement')
	} finally {
		await close()
	}
})
