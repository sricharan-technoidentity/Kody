import { processCloudflareArtifactsRepoEvent } from './package-subscriptions.ts'

/**
 * One `artifacts-repo-events` provider event (a `QueueMessage` workflow).
 * `waitUntil` work belongs to the caller, which awaits it.
 */
export async function processArtifactsRepoEventMessage(
	body: unknown,
	env: Env,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<'ack' | 'retry'> {
	try {
		const result = await processCloudflareArtifactsRepoEvent({
			env,
			body,
			waitUntil,
		})
		switch (result.outcome) {
			case 'invalid':
			case 'ignored':
			case 'dispatched':
				return 'ack'
			case 'unmatched': {
				// Create can race D1 insert; retry briefly. Deleted events after
				// entity_sources cleanup are expected misses — ack without fan-out.
				if (result.providerEvent.type === 'cf.artifacts.repo.deleted') {
					return 'ack'
				}
				console.warn('artifacts-repo-event-unmatched', {
					type: result.providerEvent.type,
					repoName: result.providerEvent.source.repoName,
					namespace: result.providerEvent.source.namespace,
				})
				return 'retry'
			}
			default: {
				const exhaustive: never = result
				throw new Error(
					`Unsupported Artifacts repo event queue outcome: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	} catch (error) {
		console.error('artifacts-repo-event-processing-failed', error)
		return 'retry'
	}
}
