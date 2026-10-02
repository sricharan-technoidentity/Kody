import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import { type CommunityListingPublishedDispatchQueueMessage } from './listing-published-dispatch-queue-producer.ts'
import { dispatchCommunityListingPublishedSubscriptionEvent } from './listing-published-package-subscriptions.ts'

function parseCommunityListingPublishedDispatchQueueMessage(
	body: unknown,
): CommunityListingPublishedDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = record['eventId']
	const listingId = record['listingId']
	if (
		Object.keys(record).length !== 2 ||
		typeof eventId !== 'string' ||
		!eventId.trim() ||
		typeof listingId !== 'string' ||
		!listingId.trim()
	) {
		return null
	}
	return {
		eventId: eventId.trim(),
		listingId: listingId.trim(),
	}
}

/** One `community-listing-published-dispatch` message (a `QueueMessage` workflow). */
export async function processCommunityListingPublishedDispatchMessage(
	body: unknown,
	env: Env,
): Promise<'ack' | 'retry'> {
	const parsed = parseCommunityListingPublishedDispatchQueueMessage(body)
	if (!parsed) return 'ack'
	try {
		await dispatchCommunityListingPublishedSubscriptionEvent({
			env,
			...parsed,
		})
		return 'ack'
	} catch (error) {
		if (error instanceof CommunityListingPublishedDispatchCancelledError) {
			return 'ack'
		}
		console.error(
			'community-listing-published-dispatch-queue-processing-failed',
			{ ...parsed, error },
		)
		return 'retry'
	}
}
