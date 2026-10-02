import {
	type Client,
	WorkflowExecutionAlreadyStartedError,
	type WorkflowStartOptions,
} from '@temporalio/client'
import { type KodyTemporal } from '#worker/temporal/client.ts'

export type RecordedStart = {
	workflowType: string
	workflowId: string
	taskQueue: string
	args: Array<unknown>
}

/**
 * A `TEMPORAL` binding that records Starts instead of running them, for
 * producer tests (what `{ send: vi.fn() }` queue mocks were). A repeated
 * workflow id is rejected as Temporal does.
 */
export function createRecordingTemporal() {
	const starts: Array<RecordedStart> = []
	const failures: Array<Error> = []
	const client = {
		workflow: {
			async start(workflowType: string, options: WorkflowStartOptions) {
				const failure = failures.shift()
				if (failure) throw failure
				if (starts.some((start) => start.workflowId === options.workflowId)) {
					throw new WorkflowExecutionAlreadyStartedError(
						'Workflow execution already started',
						options.workflowId,
						workflowType,
					)
				}
				starts.push({
					workflowType,
					workflowId: options.workflowId,
					taskQueue: options.taskQueue,
					args: structuredClone((options.args ?? []) as Array<unknown>),
				})
				return { workflowId: options.workflowId }
			},
		},
	} as unknown as Client
	return {
		TEMPORAL: { client: async () => client } satisfies KodyTemporal,
		starts,
		/** The next Start throws `error` (an unreachable Temporal). */
		failNext(error: Error) {
			failures.push(error)
		},
	}
}
