import {
	WithStartWorkflowOperation,
	WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { type AwsEnv } from '../aws/env.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { kodySearchAttributes } from './search-attributes.ts'
import {
	admitWebhookDeliveryUpdate,
	type WebhookDelivery,
} from './workflows/webhook-delivery.ts'

async function hmacSha256Hex(secret: string, body: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(body),
	)
	return Buffer.from(signature).toString('hex')
}

/**
 * Front-door ingress: HMAC and replay checks are reads, then one
 * Update-with-Start on `WebhookDelivery` (`{endpointId}:{deliveryId}`).
 * Bad signatures and replays start nothing.
 */
export async function deliverWebhook(input: {
	env: AwsEnv
	userId: string
	endpointId: string
	deliveryId: string
	mode: 'ack' | 'sync'
	request: Request
	webhookSecret: string
	replayToleranceSeconds: number
	rateLimitPerMinute: number
}): Promise<{ status: number; workflowId?: string; result?: unknown }> {
	const body = await input.request.text()
	const signature = input.request.headers.get('x-kody-signature') ?? ''
	const expected = await hmacSha256Hex(input.webhookSecret, body)
	if (!(await timingSafeEqualString(signature, expected))) {
		throw new Error('Webhook signature does not match.')
	}
	const timestamp = Number(input.request.headers.get('x-kody-timestamp'))
	if (
		!Number.isFinite(timestamp) ||
		Math.abs(Date.now() / 1_000 - timestamp) > input.replayToleranceSeconds
	) {
		throw new Error('Webhook timestamp is outside the replay window.')
	}
	const workflowId = workflowIds.webhookDelivery(
		input.endpointId,
		input.deliveryId,
	)
	const client = await input.env.TEMPORAL.client(taskQueues.app)
	const startWorkflowOperation = new WithStartWorkflowOperation<
		typeof WebhookDelivery
	>('WebhookDelivery', {
		workflowId,
		taskQueue: taskQueues.app,
		args: [
			{
				userId: input.userId,
				endpointId: input.endpointId,
				deliveryId: input.deliveryId,
				packageId: input.endpointId,
				exportName: null,
				params: { body },
				rateLimitPerMinute: input.rateLimitPerMinute,
			},
		],
		// A running delivery attaches; a finished one is never re-run.
		workflowIdConflictPolicy: 'USE_EXISTING',
		workflowIdReusePolicy: 'REJECT_DUPLICATE',
		typedSearchAttributes: [
			{ key: kodySearchAttributes.userId, value: input.userId },
			{ key: kodySearchAttributes.surface, value: 'webhook' },
		],
	})
	try {
		const response = await client.workflow.executeUpdateWithStart(
			admitWebhookDeliveryUpdate,
			{ args: [{ mode: input.mode }], startWorkflowOperation },
		)
		return { ...response, workflowId }
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
		const finished = await client.workflow
			.getHandle<typeof WebhookDelivery>(workflowId)
			.result()
		if (finished.status === 'rejected') {
			return { status: 429, workflowId }
		}
		return input.mode === 'ack'
			? { status: 202, workflowId }
			: { status: 200, workflowId, result: finished.result }
	}
}
