import { expect, test, vi } from 'vitest'
import { type Client } from '@temporalio/client'
import {
	listTemporalWorkflowsForReconciliation,
	startTemporalWorkflow,
} from './workflows.ts'

test('dynamic workflow starts carry only opaque reconciliation memo fields', async () => {
	const start = vi.fn(
		async (
			_workflowType: string,
			_options: { memo?: Record<string, string> },
		) => ({
			workflowId: 'kody-package-v1:workflow-hash',
			firstExecutionRunId: 'run-1',
		}),
	)
	const client = { workflow: { start } } as unknown as Client
	await startTemporalWorkflow(client, {
		workflowType: 'dynamicPackageWorkflow',
		workflowId: 'kody-package-v1:workflow-hash',
		taskQueue: 'kody-foundation',
		input: {
			workflowId: 'kody-package-v1:workflow-hash',
			userHash: 'opaque-user-hash',
			workflowRunId: 'opaque-run-id',
			sourceRef: 'artifact:source.opaque',
			requestedRunAt: '2026-09-23T14:00:00.000Z',
			idempotencyKey: 'opaque-idempotency-key',
			callerContextRef: 'artifact:caller.opaque',
		},
	})

	expect(start).toHaveBeenCalledWith(
		'dynamicPackageWorkflow',
		expect.objectContaining({
			memo: {
				kodyUserHash: 'opaque-user-hash',
				kodyWorkflowRunId: 'opaque-run-id',
				kodyCallerContextRef: 'artifact:caller.opaque',
			},
		}),
	)
	const startOptions = start.mock.calls[0]?.[1] as
		| { memo?: Record<string, string> }
		| undefined
	expect(JSON.stringify(startOptions?.memo)).not.toContain(
		'artifact:source.opaque',
	)
	expect(JSON.stringify(startOptions?.memo)).not.toContain('2026-09-23')
})

test('reconciliation visibility samples are bounded and report truncation', async () => {
	async function* list() {
		for (let index = 0; index < 3; index += 1) {
			yield {
				workflowId: `kody-package-v1:${String(index)}`,
				status: { name: index === 0 ? 'COMPLETED' : 'RUNNING' },
				startTime: new Date('2026-09-23T14:00:00.000Z'),
				closeTime:
					index === 0 ? new Date('2026-09-23T14:01:00.000Z') : undefined,
				memo: {
					kodyUserHash: `user-hash-${String(index)}`,
					kodyWorkflowRunId: `run-${String(index)}`,
					kodyCallerContextRef: `artifact:caller-${String(index)}`,
				},
			}
		}
	}
	const client = { workflow: { list } } as unknown as Client
	const sample = await listTemporalWorkflowsForReconciliation(client, {
		workflowType: 'dynamicPackageWorkflow',
		limit: 2,
	})

	expect(sample.truncated).toBe(true)
	expect(sample.executions).toHaveLength(2)
	expect(sample.executions[0]).toMatchObject({
		workflowType: 'dynamicPackageWorkflow',
		status: 'COMPLETED',
		userHash: 'user-hash-0',
		workflowRunId: 'run-0',
		callerContextRef: 'artifact:caller-0',
	})
})
