import { dispatchCommunityActivityRecordedSubscriptionEvent } from './activity-package-subscriptions.ts'
import { type CommunityActivityDispatchQueueMessage } from './activity-dispatch-queue-producer.ts'
import { CommunityActivityDispatchCancelledError } from './errors.ts'
import { communityActivityKinds } from './types.ts'

function parseCommunityActivityDispatchQueueMessage(
	body: unknown,
): CommunityActivityDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = record['eventId']
	const kind = record['kind']
	const activityId = record['activityId']
	if (
		Object.keys(record).length !== 3 ||
		typeof eventId !== 'string' ||
		!eventId.trim() ||
		typeof kind !== 'string' ||
		!communityActivityKinds.some((candidate) => candidate === kind) ||
		typeof activityId !== 'string' ||
		!activityId.trim()
	) {
		return null
	}
	return {
		eventId: eventId.trim(),
		kind: kind as CommunityActivityDispatchQueueMessage['kind'],
		activityId: activityId.trim(),
	}
}

/** One `community-activity-dispatch` message (a `QueueMessage` workflow). */
export async function processCommunityActivityDispatchMessage(
	body: unknown,
	env: Env,
): Promise<'ack' | 'retry'> {
	const parsed = parseCommunityActivityDispatchQueueMessage(body)
	if (!parsed) return 'ack'
	try {
		await dispatchCommunityActivityRecordedSubscriptionEvent({
			env,
			...parsed,
		})
		return 'ack'
	} catch (error) {
		if (error instanceof CommunityActivityDispatchCancelledError) return 'ack'
		console.error('community-activity-dispatch-queue-processing-failed', {
			...parsed,
			error,
		})
		return 'retry'
	}
}
