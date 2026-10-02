import { proxyActivities } from '@temporalio/workflow'
import {
	type KodyActivities,
	type QueueMessageInput,
} from '../activities/types.ts'

const { processQueueMessage } = proxyActivities<
	Pick<KodyActivities, 'processQueueMessage'>
>({
	startToCloseTimeout: '5 minutes',
	// The Cloudflare consumers' policy: 30 s between attempts, three retries.
	// A failed workflow is the dead-letter record (Temporal UI can reset it).
	retry: {
		initialInterval: '30 seconds',
		backoffCoefficient: 1,
		maximumAttempts: 4,
	},
})

/** One former queue message (`queue:{queue}:{key}`). */
export async function QueueMessage(input: QueueMessageInput): Promise<void> {
	await processQueueMessage(input)
}
