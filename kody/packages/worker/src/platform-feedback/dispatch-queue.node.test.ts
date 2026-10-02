import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent:
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
}))

const { processPlatformFeedbackDispatchMessage } =
	await import('./dispatch-queue.ts')

const feedbackId = 'feedback-1'

test('platform feedback messages ack valid, invalid, and cancelled bodies and retry transient failures', async () => {
	consoleError.mockImplementation(() => {})
	mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new PlatformFeedbackDispatchCancelledError('feedback-deleted'),
		)
		.mockRejectedValueOnce(new Error('D1 lookup unavailable'))
		.mockRejectedValueOnce(new Error('subscription wrapper unavailable'))
	const env = { APP_DB: {} } as Env
	const outcomes = []
	for (const body of [
		{ feedbackId },
		{ feedbackId },
		{},
		{ feedbackId: '   ' },
		{ feedbackId, summary: 'must not cross the queue boundary' },
		{ feedbackId: 'feedback-deleted' },
		{ feedbackId: 'feedback-load-failure' },
		{ feedbackId },
	]) {
		outcomes.push(await processPlatformFeedbackDispatchMessage(body, env))
	}

	expect(outcomes).toEqual([
		'ack',
		'ack',
		'ack',
		'ack',
		'ack',
		'ack',
		'retry',
		'retry',
	])
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenCalledTimes(5)
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(3, {
		env: expect.anything(),
		feedbackId: 'feedback-deleted',
	})
	expect(consoleError).toHaveBeenCalledTimes(2)
	expect(consoleError).toHaveBeenCalledWith(
		'platform-feedback-dispatch-queue-processing-failed',
		expect.objectContaining({
			feedbackId: 'feedback-load-failure',
			error: expect.any(Error),
		}),
	)
})
