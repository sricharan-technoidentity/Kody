import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { applyOutboundEmailAbusePause } from './outbound-abuse.ts'
import { dispatchEmailDeliverySubscriptionEvents } from './package-subscriptions.ts'
import { type EmailReportingEnv } from './reporting-events.ts'
import { notifyAdminsOfVerificationDeliveryFailure } from './verification-delivery-notify.ts'
import { transactionalEmailVerificationKind } from './verification-delivery.ts'

/**
 * One `email-delivery` provider event (a `QueueMessage` workflow).
 * `waitUntil` work belongs to the caller, which awaits it.
 */
export async function processEmailDeliveryMessage(
	body: unknown,
	env: Env,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<'ack' | 'retry'> {
	try {
		const result = await processCloudflareEmailDeliveryEvent({
			env,
			reportingEnv: env as Env & EmailReportingEnv,
			body,
		})
		switch (result.outcome) {
			case 'invalid':
				return 'ack'
			case 'recorded_transactional': {
				const status = result.event.status
				const isTerminalFailure =
					!result.event.alreadyTerminal &&
					(status === 'bounced' ||
						status === 'failed' ||
						status === 'rejected' ||
						status === 'complained')
				if (isTerminalFailure) {
					if (result.event.kind === transactionalEmailVerificationKind) {
						console.warn('email-verification-delivery-failed', {
							status,
							class: result.event.class,
						})
						await notifyAdminsOfVerificationDeliveryFailure({
							env,
							event: result.event,
							waitUntil,
						})
					} else {
						console.warn('email-destination-verification-delivery', {
							status,
							class: result.event.class,
							kind: result.event.kind,
						})
					}
				}
				return 'ack'
			}
			case 'unmatched':
				console.warn('email-delivery-event-unmatched', {
					providerMessageId: result.providerEvent?.payload.messageId ?? null,
				})
				return 'retry'
			case 'stale':
				// Out-of-order events still count toward the abuse
				// thresholds when they persisted: the bounce/complaint
				// happened even when a newer status already superseded
				// it. Conflicting duplicates that were not inserted only
				// pause when persisted events back them.
				await applyOutboundEmailAbusePause({
					env,
					userId: result.message.userId,
					deliveryStatus: result.providerEvent.payload.delivery.status,
					eventRecorded: false,
					waitUntil,
				})
				return 'ack'
			case 'duplicate':
			case 'recorded': {
				// Abuse evaluation runs before subscription dispatch (and
				// also for replayed duplicates) so a crash or dispatch
				// failure can never skip the pause; the pause write itself
				// is idempotent.
				await applyOutboundEmailAbusePause({
					env,
					userId: result.message.userId,
					deliveryStatus: result.providerEvent.payload.delivery.status,
					eventRecorded: result.outcome === 'recorded',
					waitUntil,
				})
				await dispatchEmailDeliverySubscriptionEvents({
					env,
					message: result.message,
					providerEvent: result.providerEvent,
					waitUntil,
				})
				return 'ack'
			}
			default: {
				const exhaustive: never = result
				throw new Error(
					`Unsupported email delivery queue outcome: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	} catch (error) {
		console.error('email-delivery-event-processing-failed', error)
		return 'retry'
	}
}
