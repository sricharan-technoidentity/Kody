import { ApplicationFailure } from '@temporalio/common'
import { expect, test, vi } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { type DynamicCallableWorkflowPayload } from '#worker/package-runtime/package-workflows.ts'
import { createTemporalPackageWorkflowBinding } from './package-workflow.ts'
import { type PackageWorkflowActivities } from './package-workflow-activities.ts'

const payload = (key: string): DynamicCallableWorkflowPayload => ({
	version: 3,
	sourceType: 'inline',
	userId: 'alice',
	packageContext: null,
	workflowName: 'timer',
	code: 'export default () => 42',
	idempotencyKey: key,
	runAt: new Date(Date.now() + 2_000).toISOString(),
	planDate: null,
})

test('package workflows wait durably, retry infrastructure, record usage once, and cancel before executing', async () => {
	const temporal = await createTemporalEnv()
	try {
		const execute = vi
			.fn()
			.mockRejectedValueOnce(new Error('temporary transport failure'))
			.mockResolvedValue(42)
		const project = vi.fn()
		const usage = vi.fn()
		const activities: PackageWorkflowActivities = {
			executePackageWorkflow: execute,
			projectPackageWorkflow: project,
			recordPackageWorkflowUsage: usage,
		}
		await temporal.startWorker({
			taskQueue: 'runtime',
			activities: activities as unknown as Record<
				string,
				(...args: never[]) => unknown
			>,
		})
		const engine = createTemporalPackageWorkflowBinding(temporal.temporal)
		const params = payload('one')
		const instance = await engine.create({ id: 'alice:wf:one', params })
		expect(execute).not.toHaveBeenCalled()
		expect(await temporal.client.workflow.getHandle(instance.id).result()).toBe(
			42,
		)
		expect(execute).toHaveBeenCalledTimes(2)
		expect(project.mock.calls.map(([input]) => input.status)).toEqual([
			'running',
			'complete',
		])
		expect(usage).toHaveBeenCalledTimes(1)
		expect(usage).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: 'success',
				startedAtMs: expect.any(Number),
			}),
		)
		expect(await instance.status()).toMatchObject({ status: 'complete' })
		await engine.create({ id: instance.id, params })
		expect(execute).toHaveBeenCalledTimes(2)
		expect(usage.mock.calls[0]?.[0].startedAtMs).toBeGreaterThanOrEqual(
			Date.parse(params.runAt),
		)

		const cancelled = await engine.create({
			id: 'alice:wf:cancel',
			params: payload('cancel'),
		})
		await cancelled.terminate()
		expect(await cancelled.status()).toMatchObject({ status: 'cancelled' })
		expect(execute).toHaveBeenCalledTimes(2)
		expect(project).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		)
		expect(usage).toHaveBeenCalledTimes(1)

		execute.mockRejectedValue(
			ApplicationFailure.nonRetryable('Suspended.', 'AccountSuspendedError'),
		)
		const suspended = await engine.create({
			id: 'alice:wf:suspended',
			params: { ...payload('suspended'), runAt: new Date().toISOString() },
		})
		await expect(
			temporal.client.workflow.getHandle(suspended.id).result(),
		).rejects.toThrow('Workflow execution failed')
		expect(execute).toHaveBeenCalledTimes(3)
		expect(await suspended.status()).toMatchObject({ status: 'errored' })
		expect(project).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: 'errored', lastError: 'Suspended.' }),
		)
		expect(usage).toHaveBeenLastCalledWith(
			expect.objectContaining({ outcome: 'error' }),
		)
	} finally {
		await temporal.close()
	}
}, 60_000)
