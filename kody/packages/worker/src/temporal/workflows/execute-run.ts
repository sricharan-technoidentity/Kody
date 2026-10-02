import { ApplicationFailure } from '@temporalio/common'
import {
	allHandlersFinished,
	condition,
	defineUpdate,
	proxyActivities,
	setHandler,
	uuid4,
} from '@temporalio/workflow'
import { type KodyActivities, type RunOutcome } from '../activities/types.ts'

export type ExecuteRunInput = {
	userId: string
	requestId: string
	code: string
}

export const executeResultUpdate = defineUpdate<RunOutcome>('result')

const { consumeMeter } = proxyActivities<Pick<KodyActivities, 'consumeMeter'>>({
	startToCloseTimeout: '10 seconds',
})
const { executeCode } = proxyActivities<Pick<KodyActivities, 'executeCode'>>({
	startToCloseTimeout: '90 seconds',
	retry: { maximumAttempts: 1 },
})

/** The innermost message of an activity failure (`ActivityFailure.cause`). */
function failureMessage(error: unknown) {
	const cause = (error as { cause?: unknown }).cause
	if (cause instanceof Error) return cause.message
	return error instanceof Error ? error.message : String(error)
}

/**
 * `{userId}:execute:{requestId}`, started with Update-with-Start by the MCP
 * server: quota, one sandbox activity, result returned by the Update.
 */
export async function ExecuteRun(input: ExecuteRunInput): Promise<RunOutcome> {
	let outcome: RunOutcome | undefined
	let failure: string | undefined
	setHandler(executeResultUpdate, async () => {
		await condition(() => outcome !== undefined || failure !== undefined)
		if (failure !== undefined) {
			throw ApplicationFailure.nonRetryable(failure, 'ExecuteRejected')
		}
		return outcome!
	})
	try {
		await consumeMeter({
			userId: input.userId,
			counter: 'execute_calls_per_day',
		})
		outcome = await executeCode({
			userId: input.userId,
			requestId: input.requestId,
			runId: uuid4(),
			code: input.code,
		})
	} catch (error) {
		failure = failureMessage(error)
		await condition(allHandlersFinished)
		throw ApplicationFailure.nonRetryable(failure, 'ExecuteRejected')
	}
	await condition(allHandlersFinished)
	return outcome
}
