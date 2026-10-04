import { ApplicationFailure, proxyActivities } from '@temporalio/workflow'
import { type MailActivities } from '../mail-activities.ts'
const mail = proxyActivities<MailActivities>({
	startToCloseTimeout: '5 minutes',
	retry: { maximumAttempts: 4 },
})
/** The persisted provider event precedes the account pause and subscription fan-out. */
export async function DeliveryEvents(input: { body: unknown }) {
	const result = await mail.recordMailDelivery(input)
	if (result.outcome === 'invalid') return 'ack'
	if (result.outcome === 'unmatched')
		throw ApplicationFailure.create({
			message: 'Provider message has not been indexed yet',
			type: 'UnmatchedEmail',
			nonRetryable: false,
		})
	if (
		result.outcome === 'stale' ||
		result.outcome === 'duplicate' ||
		result.outcome === 'recorded'
	) {
		await mail.pauseOutboundMail({
			userId: result.message.userId,
			status: result.providerEvent.payload.delivery.status,
			eventRecorded: result.outcome === 'recorded',
			at: result.providerEvent.metadata.eventTimestamp,
		})
	}
	await mail.dispatchMailDelivery(result)
	return 'ack'
}
