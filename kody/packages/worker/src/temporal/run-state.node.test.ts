import { expect, test } from 'vitest'
import { createDynamoInvocationLedger } from '#worker/aws/dynamo-invocation-ledger.ts'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import {
	type WorkflowProjectionUpsertInput,
	workflowProjectionCreatingTtlMs,
} from '#worker/run-records/workflow-projection.ts'
import { workflowProjectionRetentionDays } from '#worker/run-records/types.ts'
import { createRunState } from './run-state.ts'
import { taskQueues } from './ids.ts'
import { kodySearchAttributes } from './search-attributes.ts'

const projection = (
	id: string,
	status = 'creating',
): WorkflowProjectionUpsertInput => ({
	id,
	bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
	sourceType: 'inline',
	workflowName: 'private-name',
	idempotencyKey: id,
	runAt: new Date().toISOString(),
	status,
})

test('Temporal owner registry serializes concurrent reservations, keeps active projections, prunes terminal history and isolates users', async () => {
	const testEnv = await createTemporalEnv()
	try {
		await testEnv.startWorkers({
			queues: [taskQueues.runtime],
			activities: { projectPackageWorkflow: async () => undefined },
		})
		const ledger = createDynamoInvocationLedger({
			region: 'us-east-1',
			tableName: 'ledger',
			send: createFakeDynamo().send,
		})
		const state = createRunState({ ledger, temporal: testEnv.temporal })
		const alice = state.forUser('alice')
		const bob = state.forUser('bob')
		const reserved = await Promise.all([
			alice.reserveWorkflowProjectionSlot(projection('alice:wf:one')),
			alice.reserveWorkflowProjectionSlot(projection('alice:wf:two')),
		])
		expect(reserved.map((row) => row.countBeforeReservation).sort()).toEqual([
			0, 1,
		])
		expect(reserved.every((row) => row.reserved && row.inserted)).toBe(true)
		expect(
			await alice.reserveWorkflowProjectionSlot(projection('alice:wf:one')),
		).toMatchObject({
			countBeforeReservation: 1,
			reserved: true,
			inserted: false,
		})
		await alice.upsertWorkflowProjection(projection('alice:wf:one', 'running'))
		expect(
			await alice.deleteWorkflowProjectionIfCreating({ id: 'alice:wf:one' }),
		).toEqual({ deleted: false })
		expect(await bob.getWorkflowProjection({ id: 'alice:wf:one' })).toBeNull()
		expect(
			await alice.findWorkflowProjectionByIdempotencyKey({
				idempotencyKey: 'alice:wf:two',
			}),
		).toBeNull()
		expect(
			await alice.findWorkflowProjectionByBindingIdempotencyKey({
				idempotencyKey: 'alice:wf:two',
				bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			}),
		).toMatchObject({ status: 'creating' })
		const doneAt = new Date(Date.now() + 1000).toISOString()
		await alice.upsertWorkflowProjection({
			...projection('alice:wf:done', 'complete'),
			updatedAt: doneAt,
			completedAt: doneAt,
		})
		await alice.upsertWorkflowProjection({
			...projection('alice:wf:done', 'running'),
			updatedAt: new Date(Date.now() + 2000).toISOString(),
		})
		expect(
			await alice.getWorkflowProjection({ id: 'alice:wf:done' }),
		).toMatchObject({ status: 'complete', updatedAt: doneAt })
		await expect(
			bob.upsertWorkflowProjection(projection('alice:wf:foreign')),
		).rejects.toMatchObject({
			message: 'Workflow Update failed',
			cause: { message: 'Projection owner mismatch.' },
		})
		expect(
			await bob.getWorkflowProjection({ id: 'alice:wf:foreign' }),
		).toBeNull()
		const staleCreating = new Date(
			Date.now() - workflowProjectionCreatingTtlMs - 1000,
		).toISOString()
		await alice.upsertWorkflowProjection({
			...projection('alice:wf:stale'),
			updatedAt: staleCreating,
		})
		const expired = new Date(
			Date.now() - (workflowProjectionRetentionDays + 1) * 86400000,
		).toISOString()
		await alice.upsertWorkflowProjection({
			...projection('alice:wf:old', 'complete'),
			updatedAt: expired,
			completedAt: expired,
		})
		await alice.upsertWorkflowProjection({
			...projection('alice:wf:active-old', 'running'),
			createdAt: expired,
			updatedAt: expired,
		})
		// A mutation runs the retention pass; active state never ages out with run history.
		await alice.reserveWorkflowProjectionSlot(projection('alice:wf:trigger'))
		const rows = (await alice.exportState()).workflowProjections
		expect(rows.map((row) => row.id).sort()).toEqual([
			'alice:wf:active-old',
			'alice:wf:done',
			'alice:wf:one',
			'alice:wf:trigger',
			'alice:wf:two',
		])
		const first = await alice.listWorkflowProjections({ limit: 2 })
		expect(first.projections).toHaveLength(2)
		expect(
			(
				await alice.listWorkflowProjections({
					limit: 3,
					cursor: first.nextCursor,
				})
			).projections,
		).toHaveLength(3)
		expect(await alice.countActiveWorkflowProjections()).toEqual({ count: 4 })
		const terminatedId = 'alice:wf:terminated'
		await alice.reserveWorkflowProjectionSlot(projection(terminatedId))
		await alice.upsertWorkflowProjection(projection(terminatedId, 'paused'))
		const execution = await testEnv.client.workflow.start(
			'PackageWorkflowRun',
			{
				workflowId: terminatedId,
				taskQueue: taskQueues.runtime,
				args: [
					{
						userId: 'alice',
						runAt: new Date(Date.now() + 86400000).toISOString(),
					},
				],
				typedSearchAttributes: [
					{ key: kodySearchAttributes.userId, value: 'alice' },
				],
			},
		)
		await execution.terminate(
			'test external termination before projection bookkeeping',
		)
		await expect
			.poll(
				async () =>
					(await alice.getWorkflowProjection({ id: terminatedId }))?.status,
				{ timeout: 10000 },
			)
			.toBe('terminated')
		// Visibility reconciliation updates the authoritative reservation state as well.
		expect(
			await alice.reserveWorkflowProjectionSlot(
				projection('alice:wf:after-termination'),
			),
		).toMatchObject({ countBeforeReservation: 4 })
		const cancelledId = 'alice:wf:cancelled'
		await alice.reserveWorkflowProjectionSlot(projection(cancelledId))
		const cancelled = await testEnv.client.workflow.start(
			'PackageWorkflowRun',
			{
				workflowId: cancelledId,
				taskQueue: taskQueues.runtime,
				args: [
					{
						userId: 'alice',
						runAt: new Date(Date.now() + 86400000).toISOString(),
					},
				],
				typedSearchAttributes: [
					{ key: kodySearchAttributes.userId, value: 'alice' },
				],
			},
		)
		await cancelled.cancel()
		await expect(cancelled.result()).rejects.toThrow(
			'Workflow execution cancelled',
		)
		await expect
			.poll(
				async () =>
					(await alice.getWorkflowProjection({ id: cancelledId }))?.status,
				{ timeout: 10000 },
			)
			.toBe('cancelled')
		await alice.clear()
		expect((await alice.exportState()).workflowProjections).toEqual([])
	} finally {
		await testEnv.close()
	}
}, 120000)
