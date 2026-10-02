import { type KodyTemporal } from '#worker/temporal/client.ts'
import { startQueueMessage } from '#worker/temporal/start.ts'
import { type CommunityActivityKind } from './types.ts'

export type CommunityActivityDispatchQueueMessage = {
	eventId: string
	kind: CommunityActivityKind
	activityId: string
}

export async function enqueueCommunityActivityDispatch(input: {
	env: { TEMPORAL?: KodyTemporal }
	kind: CommunityActivityKind
	activityId: string
}) {
	const body: CommunityActivityDispatchQueueMessage = {
		eventId: crypto.randomUUID(),
		kind: input.kind,
		activityId: input.activityId,
	}
	await startQueueMessage(input.env, {
		queue: 'community-activity-dispatch',
		key: body.eventId,
		body,
	})
}
