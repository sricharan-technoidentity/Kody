import { expect, test } from 'vitest'
import { createTargetTestEnv } from '#worker/test-support/aws/target-test-env.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { invokeCapability } from './capability-broker.ts'

test('broker verifies each call, derives storage from signed provenance and enforces retriever read-only SQL', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		env.kv.put({ pk: 'alice:meters', sk: 'storage_bytes', remaining: 1000000 })
		const claims = {
			userId: 'alice',
			runId: 'run',
			expiresAt: Date.now() + 60000,
			retriever: false,
			provenance: [
				{ moduleId: 'main', packageId: 'pkg', storageId: 'package:pkg' },
			],
		}
		const token = await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, claims)
		const call = (sql: string, runToken = token) =>
			invokeCapability({
				env,
				runToken,
				capability: 'storage.sql',
				arguments: { storageId: 'package:other', sql },
			})
		await call('CREATE TABLE items (value TEXT)')
		await call("INSERT INTO items VALUES ('hello')")
		expect(await call('SELECT value FROM items')).toEqual([['hello']])
		const retriever = await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
			...claims,
			retriever: true,
		})
		expect(await call('SELECT value FROM items', retriever)).toEqual([
			['hello'],
		])
		await expect(
			call(
				"WITH values_cte AS (SELECT 'bad') INSERT INTO items SELECT * FROM values_cte",
				retriever,
			),
		).rejects.toThrow()
		await expect(call('SELECT 1', token + 'tampered')).rejects.toThrow('token')
		await expect(
			call(
				'SELECT 1',
				await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
					...claims,
					expiresAt: 1,
				}),
			),
		).rejects.toThrow('expired')
		await expect(
			call(
				'SELECT 1',
				await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
					...claims,
					userId: 'bob',
				}),
			),
		).rejects.toThrow()
	} finally {
		await close()
	}
})
