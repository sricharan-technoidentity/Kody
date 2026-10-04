import { type AwsEnv } from '#worker/aws/env.ts'
import { type ExecuteRun } from './workflows/execute-run.ts'
import { taskQueues, workflowIds } from './ids.ts'
import {
	WithStartWorkflowOperation,
	WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client'
import { conditionalCheckFailedItem } from '#worker/aws/dynamo.ts'
import { kodySearchAttributes } from './search-attributes.ts'
import { base64UrlToBytes } from '@kody-internal/shared/base64.ts'
import { type RunOutcome } from './activities/types.ts'

export async function executeRun(input: {
	env: AwsEnv
	userId: string
	requestId: string
	code: string
}): Promise<{ workflowId: string; runId: string; result: string }> {
	if (input.env.userId !== input.userId)
		throw new Error('Execute run owner mismatch.')
	const workflowId = workflowIds.executeRun(input.userId, input.requestId)
	const temporal = input.env.TEMPORAL
	const client = await temporal.client(taskQueues.runtime)
	const claim = await temporal.idempotency?.getIdempotencyKey({
		userId: input.userId,
		surface: 'execute',
		key: workflowId,
	})
	let outcome: RunOutcome
	if (claim?.status === 'completed' && claim.result && temporal.results) {
		const object = await temporal.results.get(claim.result)
		if (!object) throw new Error('Missing durable execute result.')
		const encrypted = base64UrlToBytes(await object.text())
		const namespace = client.options.namespace
		const bytes = await input.env.kms.decrypt(encrypted, {
			userId: input.userId,
			namespace,
		})
		const stored = JSON.parse(new TextDecoder().decode(bytes)) as
			| { ok: true; value: RunOutcome }
			| { ok: false; error: string }
		if (!stored.ok) throw new Error(stored.error)
		outcome = stored.value
	} else {
		let durableStart = {
			userId: input.userId,
			surface: 'execute',
			key: workflowId,
			runId: crypto.randomUUID() as string,
		}
		if (temporal.idempotency) {
			const claimed =
				await temporal.idempotency.claimIdempotencyKey(durableStart)
			if (!claimed.claimed)
				durableStart = { ...durableStart, runId: claimed.existing.runId }
		}
		try {
			const startWorkflowOperation = new WithStartWorkflowOperation<
				typeof ExecuteRun
			>('ExecuteRun', {
				workflowId,
				taskQueue: taskQueues.runtime,
				workflowIdConflictPolicy: 'USE_EXISTING',
				workflowIdReusePolicy: 'REJECT_DUPLICATE',
				args: [
					{
						userId: input.userId,
						requestId: input.requestId,
						code: input.code,
					},
				],
				memo: { kodyIdempotency: durableStart },
				typedSearchAttributes: [
					{ key: kodySearchAttributes.userId, value: input.userId },
					{ key: kodySearchAttributes.surface, value: 'execute' },
				],
			})
			try {
				outcome = await client.workflow.executeUpdateWithStart<
					typeof ExecuteRun,
					RunOutcome,
					[]
				>('result', { args: [], startWorkflowOperation })
			} catch (error) {
				if (!(error instanceof WorkflowExecutionAlreadyStartedError))
					throw error
				outcome = await client.workflow
					.getHandle<typeof ExecuteRun>(workflowId)
					.result()
			}
			if (temporal.idempotency) {
				try {
					await temporal.idempotency.markIdempotencyKeyStarted(durableStart)
				} catch (error) {
					conditionalCheckFailedItem(error)
				}
			}
		} catch (error) {
			let cause = error
			while (cause instanceof Error && cause.cause) cause = cause.cause
			throw cause
		}
	}
	if (!outcome.ok) throw new Error(outcome.error)
	return { workflowId, runId: outcome.runId, result: outcome.output }
}
