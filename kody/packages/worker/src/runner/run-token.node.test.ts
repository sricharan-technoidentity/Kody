import { expect, test } from 'vitest'
import { mintRunToken, verifyRunToken } from './run-token.ts'

const key = 'mock-run-token-signing-key-000000000000'
test('run tokens bind owner, run, provenance and expiry, and reject malformed signatures', async () => {
	const claims = {
		userId: 'alice',
		runId: 'run-1',
		expiresAt: 2000,
		retriever: false,
		provenance: [
			{ moduleId: 'main', packageId: 'pkg', storageId: 'package:pkg' },
		],
	}
	const token = await mintRunToken(key, claims)
	expect(
		await verifyRunToken(key, token, { userId: 'alice', now: 1000 }),
	).toEqual(claims)
	await expect(
		verifyRunToken(key, token, { userId: 'bob', now: 1000 }),
	).rejects.toThrow('owner')
	await expect(verifyRunToken(key, token, { now: 2000 })).rejects.toThrow(
		'expired',
	)
	await expect(
		verifyRunToken(key, token.replace('alice', 'bob') + 'x', { now: 1000 }),
	).rejects.toThrow('token')
	for (const invalid of ['', 'a.b.c', 'a.b', token.split('.')[0] + '.AA']) {
		await expect(verifyRunToken(key, invalid, { now: 1000 })).rejects.toThrow(
			'token',
		)
	}
})
