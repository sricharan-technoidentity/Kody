import { expect, test, vi } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { handleFrontDoorRequest } from './read-write-split.ts'

test('front door reads from reader, sends forms through Temporal and honors read-after-write', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		const reader = vi.spyOn(env.reader, 'prepare')
		const writer = vi.spyOn(env.db, 'prepare')
		const get = new Request('https://kody.codes/account')
		expect(
			(await handleFrontDoorRequest({ env, userId: 'alice', request: get }))
				.status,
		).toBe(200)
		expect(reader).toHaveBeenCalled()
		expect(writer).not.toHaveBeenCalled()
		const post = new Request('https://kody.codes/account', {
			method: 'POST',
			body: 'name=Alice',
		})
		expect(
			(await handleFrontDoorRequest({ env, userId: 'alice', request: post }))
				.status,
		).toBe(200)
		expect(writer).not.toHaveBeenCalled()
		await handleFrontDoorRequest({
			env,
			userId: 'alice',
			request: get,
			readAfterWrite: true,
		})
		expect(writer).toHaveBeenCalled()
	} finally {
		await close()
	}
})
