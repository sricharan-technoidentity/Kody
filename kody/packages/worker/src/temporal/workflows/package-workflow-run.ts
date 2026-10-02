import {
	CancellationScope,
	isCancellation,
	proxyActivities,
	sleep,
	upsertSearchAttributes,
	workflowInfo,
} from '@temporalio/workflow'
import { type DynamicCallableWorkflowPayload } from '#worker/package-runtime/package-workflows.ts'
import { type JsonValue } from '@kody-internal/shared/json-safe-value.ts'
import { type PackageWorkflowActivities } from '../package-workflow-activities.ts'
import { kodySearchAttributes } from '../search-attributes.ts'

const { executePackageWorkflow } = proxyActivities<PackageWorkflowActivities>({
	startToCloseTimeout: '5 minutes',
	retry: {
		initialInterval: '30 seconds',
		backoffCoefficient: 2,
		maximumAttempts: 4,
	},
})
const { projectPackageWorkflow, recordPackageWorkflowUsage } =
	proxyActivities<PackageWorkflowActivities>({
		startToCloseTimeout: '30 seconds',
	})

/** Durable timer followed by a sandbox activity, with separately durable bookkeeping. */
export async function PackageWorkflowRun(
	payload: DynamicCallableWorkflowPayload,
): Promise<JsonValue> {
	const input = { id: workflowInfo().workflowId, payload }
	let startedAtMs: number | undefined
	try {
		await sleep(Math.max(0, Date.parse(payload.runAt) - Date.now()))
		startedAtMs = Date.now()
		upsertSearchAttributes([
			{ key: kodySearchAttributes.status, value: 'running' },
		])
		await projectPackageWorkflow({ ...input, status: 'running' })
		let result: JsonValue
		try {
			result = await executePackageWorkflow(input)
		} catch (error) {
			if (isCancellation(error)) throw error
			await projectPackageWorkflow({
				...input,
				status: 'errored',
				lastError:
					error instanceof Error && error.cause instanceof Error
						? error.cause.message
						: error instanceof Error
							? error.message
							: String(error),
				completedAt: new Date().toISOString(),
			})
			await recordPackageWorkflowUsage({
				...input,
				startedAtMs,
				outcome: 'error',
			})
			upsertSearchAttributes([
				{ key: kodySearchAttributes.status, value: 'errored' },
			])
			throw error
		}
		await projectPackageWorkflow({
			...input,
			status: 'complete',
			completedAt: new Date().toISOString(),
		})
		await recordPackageWorkflowUsage({
			...input,
			startedAtMs,
			outcome: 'success',
		})
		upsertSearchAttributes([
			{ key: kodySearchAttributes.status, value: 'complete' },
		])
		return result
	} catch (error) {
		if (isCancellation(error)) {
			await CancellationScope.nonCancellable(async () => {
				await projectPackageWorkflow({
					...input,
					status: 'cancelled',
					completedAt: new Date().toISOString(),
				})
				upsertSearchAttributes([
					{ key: kodySearchAttributes.status, value: 'cancelled' },
				])
			})
		}
		throw error
	}
}
