import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { executeRun } from './execute-run.ts'

test('execute is idempotent, consumes a finite meter and records one bounded Runner result', async () => {
	const userId = 'a'.repeat(64)
	const { env, close } = await createTargetTestEnv({ userId })
	try {
		env.kv.put({ pk: `${userId}:meters`, sk: 'execute', remaining: 1 })
		env.runner.respondWith({ output: 'ok', sandboxComputeMs: 5 })
		const input = { env, userId, requestId: 'req-1', code: 'return 1' }
		const first = await executeRun(input)
		const duplicate = await executeRun(input)
		expect(first.workflowId).toBe(`${userId}:execute:req-1`)
		expect(duplicate.runId).toBe(first.runId)
		expect(first.result).toBe('ok')
		expect(new TextEncoder().encode(first.result).length).toBeLessThanOrEqual(
			100 * 1024,
		)
		expect(env.runner.invocations).toHaveLength(1)
		expect(env.runner.invocations[0]?.runtimeSessionId).toContain(userId)
		expect(env.runner.invocations[0]?.payload).toMatchObject({
			runToken: expect.any(String),
		})
		expect(env.kv.get(`${userId}:meters`, 'execute')?.remaining).toBe(0)
		await expect(executeRun({ ...input, requestId: 'req-2' })).rejects.toThrow(
			'entitlement',
		)
		env.kv.update(`${userId}:meters`, 'execute', (item) => ({
			...item!,
			remaining: 1,
		}))
		env.runner.respondWith({
			output: 'x'.repeat(150 * 1024),
			sandboxComputeMs: 5,
		})
		const large = await executeRun({ ...input, requestId: 'req-3' })
		expect(new TextEncoder().encode(large.result).length).toBeLessThanOrEqual(
			100 * 1024,
		)
	} finally {
		await close()
	}
})
