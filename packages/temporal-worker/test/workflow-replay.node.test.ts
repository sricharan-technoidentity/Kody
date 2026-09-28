import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from '@temporalio/worker'
import { expect, test } from 'vitest'

const workflowsPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../src/workflows/index.ts',
)

const timestamp = '2026-09-22T12:00:00.000Z'

/** CLI JSON history for the stable no-command replay canary. */
const replayHistory = {
	events: [
		{
			eventId: '1',
			eventTime: timestamp,
			eventType: 'WorkflowExecutionStarted',
			version: '0',
			taskId: '1',
			workflowExecutionStartedEventAttributes: {
				workflowType: { name: 'replayFixtureWorkflow' },
				taskQueue: { name: 'replay-test', kind: 'Normal' },
				input: { payloads: [] },
				workflowTaskTimeout: '10s',
				originalExecutionRunId: '00000000-0000-4000-8000-000000000001',
				firstExecutionRunId: '00000000-0000-4000-8000-000000000001',
				attempt: 1,
				firstWorkflowTaskBackoff: '0s',
				header: { fields: {} },
			},
		},
		{
			eventId: '2',
			eventTime: timestamp,
			eventType: 'WorkflowTaskScheduled',
			version: '0',
			taskId: '2',
			workflowTaskScheduledEventAttributes: {
				taskQueue: { name: 'replay-test', kind: 'Normal' },
				startToCloseTimeout: '10s',
				attempt: 1,
			},
		},
		{
			eventId: '3',
			eventTime: timestamp,
			eventType: 'WorkflowTaskStarted',
			version: '0',
			taskId: '3',
			workflowTaskStartedEventAttributes: {
				scheduledEventId: '2',
				identity: 'replay-test',
				requestId: '00000000-0000-4000-8000-000000000002',
			},
		},
		{
			eventId: '4',
			eventTime: timestamp,
			eventType: 'WorkflowTaskCompleted',
			version: '0',
			taskId: '4',
			workflowTaskCompletedEventAttributes: {
				scheduledEventId: '2',
				startedEventId: '3',
				identity: 'replay-test',
			},
		},
		{
			eventId: '5',
			eventTime: timestamp,
			eventType: 'WorkflowExecutionCompleted',
			version: '0',
			taskId: '5',
			workflowExecutionCompletedEventAttributes: {
				workflowTaskCompletedEventId: '4',
				result: {
					payloads: [
						{
							metadata: { encoding: 'anNvbi9wbGFpbg==' },
							data: 'InJlcGxheS1vayI=',
						},
					],
				},
			},
		},
	],
}

test('committed workflow history replays with the production workflow code', async () => {
	await expect(
		Worker.runReplayHistory(
			{ workflowsPath },
			replayHistory,
			'00000000-0000-4000-8000-000000000001',
		),
	).resolves.toBeUndefined()
})
