import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import { type PlatformFeedbackDispatchQueueMessage } from './dispatch-queue-producer.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'

function parsePlatformFeedbackDispatchQueueMessage(
	body: unknown,
): PlatformFeedbackDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const feedbackId = record['feedbackId']
	if (
		Object.keys(record).length !== 1 ||
		typeof feedbackId !== 'string' ||
		!feedbackId.trim()
	) {
		return null
	}
	return { feedbackId: feedbackId.trim() }
}

/** One `platform-feedback-dispatch` message (a `QueueMessage` workflow). */
export async function processPlatformFeedbackDispatchMessage(
	body: unknown,
	env: Env,
): Promise<'ack' | 'retry'> {
	const parsed = parsePlatformFeedbackDispatchQueueMessage(body)
	if (!parsed) return 'ack'
	try {
		await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env,
			feedbackId: parsed.feedbackId,
		})
		return 'ack'
	} catch (error) {
		if (error instanceof PlatformFeedbackDispatchCancelledError) return 'ack'
		console.error('platform-feedback-dispatch-queue-processing-failed', {
			feedbackId: parsed.feedbackId,
			error,
		})
		return 'retry'
	}
}
