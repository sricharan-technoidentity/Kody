import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { invokeCapability } from './capability-broker.ts'

test('broker verifies every run token and derives the storage bucket from provenance', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		const payload = Buffer.from(
			JSON.stringify({
				userId: 'alice',
				storageId: 'package:pkg',
				expiresAt: Date.now() + 60_000,
			}),
		).toString('base64url')
		const signature = createHmac(
			'sha256',
			process.env.RUN_TOKEN_SIGNING_KEY ??
				'mock-run-token-signing-key-000000000000',
		)
			.update(payload)
			.digest('base64url')
		const token = `${payload}.${signature}`
		const result = await invokeCapability({
			env,
			runToken: token,
			capability: 'storage.sql',
			arguments: { storageId: 'package:other', sql: 'SELECT 1' },
		})
		expect(result).toBeDefined()
		expect(env.kv.get('alice:broker', 'last-storage-id')?.value).toBe(
			'package:pkg',
		)
		await expect(
			invokeCapability({
				env,
				runToken: `${payload}.tampered`,
				capability: 'storage.sql',
				arguments: {},
			}),
		).rejects.toThrow('token')
		const expired = Buffer.from(
			JSON.stringify({
				userId: 'alice',
				storageId: 'package:pkg',
				expiresAt: 1,
			}),
		).toString('base64url')
		const expiredSignature = createHmac(
			'sha256',
			process.env.RUN_TOKEN_SIGNING_KEY ??
				'mock-run-token-signing-key-000000000000',
		)
			.update(expired)
			.digest('base64url')
		await expect(
			invokeCapability({
				env,
				runToken: `${expired}.${expiredSignature}`,
				capability: 'storage.sql',
				arguments: {},
			}),
		).rejects.toThrow('expired')
	} finally {
		await close()
	}
})
