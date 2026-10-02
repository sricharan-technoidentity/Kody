import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import { conditionalCheckFailedItem } from '#worker/aws/dynamo.ts'
import { type KodyQueue, type QueueMessageInput } from './activities/types.ts'
import { type KodyTemporal } from './client.ts'
import { taskQueues, workflowIds, type TaskQueue } from './ids.ts'
import { kodySearchAttributes } from './search-attributes.ts'

/**
 * Fire-and-forget Start: what `queue.send` and `ctx.waitUntil` background
 * work become. The workflow id is the dedupe key, so a second Start of the
 * same work is reported as `duplicate`, never run twice.
 */
export async function startKodyWorkflow(
	temporal: KodyTemporal | undefined,
	input: {
		workflowType: string
		workflowId: string
		taskQueue: TaskQueue
		args: Array<unknown>
		userId?: string
		surface?: string
		packageId?: string
	},
): Promise<'started' | 'duplicate'> {
	if (!temporal) {
		throw new Error('Missing TEMPORAL binding for durable background work.')
	}
	const client = await temporal.client(input.taskQueue)
	const durableStart =
		temporal.idempotency && input.userId && input.surface
			? {
					userId: input.userId,
					surface: input.surface,
					key: input.workflowId,
					runId: crypto.randomUUID() as string,
				}
			: undefined
	if (durableStart) {
		const claim = await temporal.idempotency!.claimIdempotencyKey({
			...durableStart,
		})
		if (
			!claim.claimed &&
			(claim.existing.status === 'completed' ||
				claim.existing.result?.startsWith('temporal:'))
		)
			return 'duplicate'
		if (!claim.claimed) durableStart.runId = claim.existing.runId
		// A running claim may precede an uncertain Start response. Retry the
		// same workflow id; Temporal resolves whether it already started.
	}
	try {
		await client.workflow.start(input.workflowType, {
			workflowId: input.workflowId,
			taskQueue: input.taskQueue,
			workflowIdReusePolicy: 'REJECT_DUPLICATE',
			args: input.args,
			...(durableStart ? { memo: { kodyIdempotency: durableStart } } : {}),
			typedSearchAttributes: [
				...(input.userId
					? [{ key: kodySearchAttributes.userId, value: input.userId }]
					: []),
				...(input.surface
					? [{ key: kodySearchAttributes.surface, value: input.surface }]
					: []),
				...(input.packageId
					? [{ key: kodySearchAttributes.packageId, value: input.packageId }]
					: []),
			],
		})
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
		await confirmStart()
		return 'duplicate'
	}
	await confirmStart()
	return 'started'

	async function confirmStart() {
		if (!durableStart) return
		try {
			await temporal!.idempotency!.markIdempotencyKeyStarted(durableStart)
		} catch (error) {
			// A fast workflow may already have persisted its terminal response.
			conditionalCheckFailedItem(error)
		}
	}
}

/** `queue.send(body)` for a former Cloudflare Queue; `key` dedupes. */
export async function startQueueMessage(
	env: { TEMPORAL?: KodyTemporal },
	input: { queue: KodyQueue; key: string; body: unknown; userId?: string },
) {
	const args: [QueueMessageInput] = [{ queue: input.queue, body: input.body }]
	return startKodyWorkflow(env.TEMPORAL, {
		workflowType: 'QueueMessage',
		workflowId: workflowIds.queueMessage(input.queue, input.key),
		taskQueue: taskQueues.platform,
		args,
		userId: input.userId,
		surface: input.queue,
	})
}
