import { processCloudflareEmailDeliveryEvent } from '#worker/email/delivery-events.ts'
import { applyOutboundEmailAbusePause } from '#worker/email/outbound-abuse.ts'
import { dispatchEmailDeliverySubscriptionEvents } from '#worker/email/package-subscriptions.ts'
import { processEmailDeliveryMessage } from '#worker/email/delivery-queue.ts'
export type DeliveryResult = Awaited<
	ReturnType<typeof processCloudflareEmailDeliveryEvent>
>
export type MailActivities = {
	recordMailDelivery(input: { body: unknown }): Promise<DeliveryResult>
	pauseOutboundMail(input: {
		userId: string
		status:
			| 'delivered'
			| 'deferred'
			| 'bounced'
			| 'failed'
			| 'rejected'
			| 'complained'
		eventRecorded: boolean
		at: string
	}): Promise<{ paused: boolean }>
	dispatchMailDelivery(input: DeliveryResult): Promise<void>
	maintainMailbox(input: { userId: string }): Promise<void>
}
export function createMailActivities(input: {
	env: Env
	forUser(userId: string): Env
}): MailActivities {
	return {
		async recordMailDelivery({ body }) {
			return processCloudflareEmailDeliveryEvent({ env: input.env, body })
		},
		async pauseOutboundMail(event) {
			return applyOutboundEmailAbusePause({
				env: input.forUser(event.userId),
				userId: event.userId,
				deliveryStatus: event.status,
				eventRecorded: event.eventRecorded,
				now: new Date(event.at),
			})
		},
		async dispatchMailDelivery(result) {
			if (result.outcome === 'duplicate' || result.outcome === 'recorded') {
				const pending: Promise<unknown>[] = []
				try {
					await dispatchEmailDeliverySubscriptionEvents({
						env: input.forUser(result.message.userId),
						message: result.message,
						providerEvent: result.providerEvent,
						waitUntil: (promise) => pending.push(promise),
					})
				} finally {
					await Promise.allSettled(pending)
				}
			} else if (result.outcome === 'recorded_transactional') {
				const pending: Promise<unknown>[] = []
				try {
					await processEmailDeliveryMessage(
						result.providerEvent,
						input.env,
						(promise) => pending.push(promise),
					)
				} finally {
					await Promise.allSettled(pending)
				}
			}
		},
		async maintainMailbox({ userId }) {
			const service = input.forUser(userId).MAILBOX_STORE
			if (!service) throw new Error('Mailbox service is not configured')
			await service.maintain(userId)
		},
	}
}
