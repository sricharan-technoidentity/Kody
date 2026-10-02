import { type KodyTemporal } from '#worker/temporal/client.ts'
import { startQueueMessage } from '#worker/temporal/start.ts'

export type CommunityListingPublishedDispatchQueueMessage = {
	eventId: string
	listingId: string
}

export async function enqueueCommunityListingPublishedDispatch(input: {
	env: { TEMPORAL?: KodyTemporal }
	listingId: string
}) {
	const body: CommunityListingPublishedDispatchQueueMessage = {
		eventId: crypto.randomUUID(),
		listingId: input.listingId,
	}
	await startQueueMessage(input.env, {
		queue: 'community-listing-published-dispatch',
		key: body.eventId,
		body,
	})
}
