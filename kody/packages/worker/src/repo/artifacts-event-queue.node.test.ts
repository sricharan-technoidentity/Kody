import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareArtifactsRepoEvent: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	processCloudflareArtifactsRepoEvent:
		mocks.processCloudflareArtifactsRepoEvent,
}))

const { processArtifactsRepoEventMessage } =
	await import('./artifacts-event-queue.ts')

test('artifacts repo events ack terminal outcomes and retry unmatched creates', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})

	mocks.processCloudflareArtifactsRepoEvent.mockImplementation(
		async (input) => {
			const kind = (input.body as { kind: string }).kind
			switch (kind) {
				case 'dispatched':
					return {
						outcome: 'dispatched',
						providerEvent: { type: 'cf.artifacts.repo.pushed' },
						source: {},
					}
				case 'ignored':
					return {
						outcome: 'ignored',
						providerEvent: { type: 'cf.artifacts.repo.pushed' },
					}
				case 'invalid':
					return { outcome: 'invalid', providerEvent: null }
				case 'unmatched-push':
					return {
						outcome: 'unmatched',
						providerEvent: {
							type: 'cf.artifacts.repo.pushed',
							source: { repoName: 'repo-1', namespace: 'production' },
						},
					}
				case 'unmatched-deleted':
					return {
						outcome: 'unmatched',
						providerEvent: {
							type: 'cf.artifacts.repo.deleted',
							source: { repoName: 'repo-1', namespace: 'production' },
						},
					}
				case 'failed':
					throw new Error('boom')
				default:
					throw new Error(`unexpected ${kind}`)
			}
		},
	)

	const outcomes = []
	for (const kind of [
		'dispatched',
		'ignored',
		'invalid',
		'unmatched-push',
		'unmatched-deleted',
		'failed',
	]) {
		outcomes.push(
			await processArtifactsRepoEventMessage({ kind }, {} as Env, vi.fn()),
		)
	}

	expect(outcomes).toEqual(['ack', 'ack', 'ack', 'retry', 'ack', 'retry'])
	expect(consoleWarn).toHaveBeenCalledWith('artifacts-repo-event-unmatched', {
		type: 'cf.artifacts.repo.pushed',
		repoName: 'repo-1',
		namespace: 'production',
	})
})
