import { expect, test } from 'vitest'
import { createFakeRunner } from './fake-runner.ts'

test('Runner records sessions and consumes scripted responses once', async () => {
	const runner = createFakeRunner()
	runner.respondWith({ output: 'ok' })
	expect(
		await runner.invoke({
			runtimeSessionId: 'alice-session',
			payload: { code: '1' },
		}),
	).toEqual({ output: 'ok' })
	expect(runner.invocations).toEqual([
		{ runtimeSessionId: 'alice-session', payload: { code: '1' } },
	])
	await expect(
		runner.invoke({ runtimeSessionId: 'alice-session', payload: {} }),
	).rejects.toThrow('scripted')
})
