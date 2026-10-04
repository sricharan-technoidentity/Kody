import { expect, test } from 'vitest'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { createBrokerHandler } from './handler.ts'

test('HTTPS broker authenticates every callback and binds registered dispatchers to their run owner', async () => {
	const signingKey = 'mock-run-token-signing-key-000000000000'
	const broker = createBrokerHandler({ signingKey })
	const seen: unknown[] = []
	const remove = broker.register({
		userId: 'alice',
		runId: 'run',
		async dispatch(capability, args) {
			seen.push({ capability, args })
			return JSON.stringify({ result: { value: 7 } })
		},
	})
	const claims = {
		userId: 'alice',
		runId: 'run',
		expiresAt: Date.now() + 60000,
		retriever: false,
		provenance: [
			{ moduleId: 'main', packageId: 'pkg', storageId: 'package:pkg' },
		],
	}
	const token = await mintRunToken(signingKey, claims)
	const call = (runToken: string, capability = 'kody.storageSql') =>
		broker.fetch(
			new Request('https://broker.internal/', {
				method: 'POST',
				headers: {
					'x-kody-run-token': runToken,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ capability, arguments: { query: 'SELECT 7' } }),
			}),
		)
	expect(await (await call(token)).json()).toEqual({ result: { value: 7 } })
	expect(seen).toHaveLength(1)
	expect((await call(token + 'tampered')).status).toBe(401)
	expect(
		(await call(await mintRunToken(signingKey, { ...claims, userId: 'bob' })))
			.status,
	).toBe(401)
	expect(
		(await call(await mintRunToken(signingKey, { ...claims, expiresAt: 1 })))
			.status,
	).toBe(401)
	expect(
		(
			await call(
				await mintRunToken(signingKey, { ...claims, retriever: true }),
				'kody.storageSet',
			)
		).status,
	).toBe(403)
	expect(seen).toHaveLength(1)
	remove()
	expect((await call(token)).status).toBe(401)
})
