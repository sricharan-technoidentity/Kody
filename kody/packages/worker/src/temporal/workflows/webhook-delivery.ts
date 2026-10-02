import {
	allHandlersFinished,
	condition,
	defineUpdate,
	proxyActivities,
	setHandler,
} from '@temporalio/workflow'
import {
	type KodyActivities,
	type RunOutcome,
	type WebhookAdmission,
} from '../activities/types.ts'
import { invokePackageChild } from './package-invocation.ts'

export type WebhookDeliveryInput = {
	userId: string
	endpointId: string
	deliveryId: string
	packageId: string
	exportName: string | null
	params: Record<string, unknown>
	/**
	 * Per-endpoint limit the Update admits against; `null` when the front
	 * door already admitted the delivery (legacy ingress order, see P5 log).
	 */
	rateLimitPerMinute: number | null
	detail?: unknown
}

export type WebhookDeliveryResponse =
	| { status: 202 }
	| { status: 200; result: RunOutcome }
	| { status: 429; retryAfterSeconds: number }

export const admitWebhookDeliveryUpdate = defineUpdate<
	WebhookDeliveryResponse,
	[{ mode: 'ack' | 'sync' }]
>('admit')

const { admitWebhookDelivery } = proxyActivities<
	Pick<KodyActivities, 'admitWebhookDelivery'>
>({ startToCloseTimeout: '10 seconds' })

/**
 * One inbound delivery (`{endpointId}:{deliveryId}`). The `admit` Update
 * applies the rate limit, so a 429 still returns immediately; `ack` returns
 * 202 once admitted and `sync` waits for the package result. A duplicate
 * delivery id attaches to this workflow instead of running twice.
 */
export async function WebhookDelivery(
	input: WebhookDeliveryInput,
): Promise<
	| { status: 'rejected'; retryAfterSeconds: number }
	| { status: 'delivered'; result: RunOutcome }
> {
	let admission: Promise<WebhookAdmission> | undefined
	let result: RunOutcome | undefined
	const admit = () =>
		(admission ??=
			input.rateLimitPerMinute === null
				? Promise.resolve({ admitted: true } as const)
				: admitWebhookDelivery({
						userId: input.userId,
						endpointId: input.endpointId,
						deliveryId: input.deliveryId,
						rateLimitPerMinute: input.rateLimitPerMinute,
					}))
	setHandler(admitWebhookDeliveryUpdate, async ({ mode }) => {
		const decision = await admit()
		if (!decision.admitted) {
			return { status: 429, retryAfterSeconds: decision.retryAfterSeconds }
		}
		if (mode === 'ack') return { status: 202 }
		await condition(() => result !== undefined)
		return { status: 200, result: result! }
	})
	const decision = await admit()
	if (!decision.admitted) {
		await condition(allHandlersFinished)
		return { status: 'rejected', retryAfterSeconds: decision.retryAfterSeconds }
	}
	result = await invokePackageChild({
		userId: input.userId,
		surface: 'webhook',
		invocationKey: input.deliveryId,
		packageId: input.packageId,
		exportName: input.exportName,
		params: input.params,
		detail: input.detail,
	})
	await condition(allHandlersFinished)
	return { status: 'delivered', result }
}
