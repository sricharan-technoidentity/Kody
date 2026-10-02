import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchCommunityListingPublishedSubscriptionEvent: vi.fn(),
}))

vi.mock('./listing-published-package-subscriptions.ts', () => ({
	dispatchCommunityListingPublishedSubscriptionEvent:
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
}))

const { processCommunityListingPublishedDispatchMessage } =
	await import('./listing-published-dispatch-queue.ts')

test('community listing published messages ack valid, invalid, and cancelled bodies and retry transient failures', async () => {
	consoleError.mockImplementation(() => {})
	mocks.dispatchCommunityListingPublishedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityListingPublishedDispatchCancelledError('listing-deleted'),
		)
		.mockRejectedValueOnce(new Error('D1 unavailable'))
	const env = { APP_DB: {} } as Env
	const outcomes = []
	for (const body of [
		{ eventId: 'event-1', listingId: 'listing-1' },
		{ eventId: 'event-2', listingId: 'listing-2', extra: true },
		{ eventId: 'event-3', listingId: 'listing-deleted' },
		{ eventId: 'event-4', listingId: 'listing-3' },
	]) {
		outcomes.push(
			await processCommunityListingPublishedDispatchMessage(body, env),
		)
	}

	expect(outcomes).toEqual(['ack', 'ack', 'ack', 'retry'])
	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		eventId: 'event-1',
		listingId: 'listing-1',
	})
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'community-listing-published-dispatch-queue-processing-failed',
		expect.objectContaining({
			eventId: 'event-4',
			listingId: 'listing-3',
			error: expect.any(Error),
		}),
	)
})
