import { proxyActivities } from '@temporalio/workflow'
import {
	type KodyActivities,
	type KodyEvent,
	type RunOutcome,
} from '../activities/types.ts'
import { invokePackageChild } from './package-invocation.ts'

const { listEventSubscribers } = proxyActivities<
	Pick<KodyActivities, 'listEventSubscribers'>
>({
	startToCloseTimeout: '1 minute',
	retry: { initialInterval: '30 seconds', backoffCoefficient: 1 },
})

/** One topic event → one `PackageInvocation` per subscriber. */
export async function EventFanout(
	event: KodyEvent,
): Promise<{ topic: string; eventId: string; runs: Array<RunOutcome> }> {
	const subscribers = await listEventSubscribers(event)
	const runs = await Promise.all(
		subscribers.map((subscriber) =>
			invokePackageChild({
				userId: subscriber.userId,
				surface: 'subscription',
				invocationKey: `${event.eventId}:${subscriber.packageId}`,
				packageId: subscriber.packageId,
				exportName: subscriber.exportName,
				params: event.payload,
				detail: subscriber.detail,
			}),
		),
	)
	return { topic: event.topic, eventId: event.eventId, runs }
}
