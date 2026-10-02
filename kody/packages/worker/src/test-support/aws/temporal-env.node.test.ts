import { expect, test } from 'vitest'
import { createTemporalEnv } from './temporal-env.ts'

test('Temporal test environment runs a time-skipping workflow on a named queue', async () => {
	const temporal = await createTemporalEnv({ timeSkipping: true })
	try {
		await temporal.startWorker({ taskQueue: 'p2-harness' })
		const result = await temporal.client.workflow.execute('harnessDelay', {
			taskQueue: 'p2-harness',
			workflowId: 'p2-harness-delay',
			args: [3_600_000],
		})
		expect(result).toBe('elapsed')
	} finally {
		await temporal.close()
	}
})
