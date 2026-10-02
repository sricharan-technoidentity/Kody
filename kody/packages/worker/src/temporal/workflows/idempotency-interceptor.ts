import {
	CancellationScope,
	ContinueAsNew,
	proxyActivities,
	workflowInfo,
	type WorkflowInterceptorsFactory,
} from '@temporalio/workflow'
import { type KodyActivities } from '../activities/types.ts'

const { completeWorkflowStart } = proxyActivities<
	Pick<KodyActivities, 'completeWorkflowStart'>
>({ startToCloseTimeout: '1 minute' })

/** Persist the result before close; the replay contract outlives history retention. */
export const interceptors: WorkflowInterceptorsFactory = () => ({
	inbound: [
		{
			async execute(input, next) {
				const claim = workflowInfo().memo?.kodyIdempotency as
					| { userId: string; surface: string; key: string; runId: string }
					| undefined
				if (!claim) return next(input)
				let result: { ok: true; value: unknown } | { ok: false; error: string }
				try {
					result = { ok: true, value: await next(input) }
				} catch (error) {
					if (error instanceof ContinueAsNew) throw error
					await CancellationScope.nonCancellable(() =>
						completeWorkflowStart({
							...claim,
							result: {
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							},
						}),
					)
					throw error
				}
				await completeWorkflowStart({ ...claim, result })
				return result.value
			},
		},
	],
})
