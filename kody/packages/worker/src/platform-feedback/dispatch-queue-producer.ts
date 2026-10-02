import { type KodyTemporal } from '#worker/temporal/client.ts'
import { startQueueMessage } from '#worker/temporal/start.ts'

export type PlatformFeedbackDispatchQueueMessage = {
	feedbackId: string
}

/** Starts the feedback's `QueueMessage` workflow (one dispatch per feedback). */
export async function enqueuePlatformFeedbackDispatch(input: {
	env: { TEMPORAL?: KodyTemporal }
	feedbackId: string
}) {
	const body: PlatformFeedbackDispatchQueueMessage = {
		feedbackId: input.feedbackId,
	}
	await startQueueMessage(input.env, {
		queue: 'platform-feedback-dispatch',
		key: input.feedbackId,
		body,
	})
}
