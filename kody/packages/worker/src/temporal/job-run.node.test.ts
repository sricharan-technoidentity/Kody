import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { runJob } from './job-run.ts'

test('a scheduled job consumes its meter and fans a failure out to a subscriber', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		env.kv.put({ pk: 'alice:meters', sk: 'job_runs_per_day', remaining: 1 })
		env.kv.put({
			pk: 'alice:subscriptions',
			sk: 'run.error.recorded#alerts',
			packageId: 'alerts',
			exportName: 'onRunError',
		})
		env.runner.respondWith({ error: 'failed' })
		env.runner.respondWith({ output: 'subscriber handled failure' })
		const result = await runJob({
			env,
			userId: 'alice',
			jobId: 'job-1',
			scheduledAt: '2026-09-30T00:00:00Z',
		})
		expect(result.scheduleId).toBe('job:alice:job-1')
		// Schedules append the fire time to the action's workflow id.
		expect(result.workflowId.startsWith('job:alice:job-1-')).toBe(true)
		expect(result.eventId).toBeDefined()
		expect(result.eventType).toBe('run.error.recorded')
		expect(result.subscriberRunId).toBeDefined()
		expect(env.kv.get('alice:meters', 'job_runs_per_day')?.remaining).toBe(0)
		expect(env.runner.invocations).toHaveLength(2)
		expect(env.runner.invocations[1]?.payload).toMatchObject({
			surface: 'subscription',
			packageId: 'alerts',
			params: { runId: result.eventId, surface: 'job', error: 'failed' },
		})
	} finally {
		await close()
	}
})
