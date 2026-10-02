import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { CommunityActivityDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchCommunityActivityRecordedSubscriptionEvent: vi.fn(),
}))

vi.mock('./activity-package-subscriptions.ts', () => ({
	dispatchCommunityActivityRecordedSubscriptionEvent:
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
}))

const { processCommunityActivityDispatchMessage } =
	await import('./activity-dispatch-queue.ts')

test('community activity messages ack valid, invalid, and cancelled bodies and retry transient failures', async () => {
	consoleError.mockImplementation(() => {})
	mocks.dispatchCommunityActivityRecordedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityActivityDispatchCancelledError({
				kind: 'rating',
				activityId: 'rating-deleted',
			}),
		)
		.mockRejectedValueOnce(new Error('D1 unavailable'))
	const env = { APP_DB: {} } as Env
	const outcomes = []
	for (const body of [
		{ eventId: 'event-1', kind: 'fork', activityId: 'fork-1' },
		{ eventId: 'event-2', kind: 'install', activityId: 'fork-2' },
		{ eventId: 'event-3', kind: 'rating', activityId: 'rating-1', stars: 5 },
		{ eventId: 'event-4', kind: 'rating', activityId: 'rating-deleted' },
		{ eventId: 'event-5', kind: 'rating', activityId: 'rating-2' },
	]) {
		outcomes.push(await processCommunityActivityDispatchMessage(body, env))
	}

	expect(outcomes).toEqual(['ack', 'ack', 'ack', 'ack', 'retry'])
	expect(
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		eventId: 'event-1',
		kind: 'fork',
		activityId: 'fork-1',
	})
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'community-activity-dispatch-queue-processing-failed',
		expect.objectContaining({
			eventId: 'event-5',
			kind: 'rating',
			activityId: 'rating-2',
			error: expect.any(Error),
		}),
	)
})
