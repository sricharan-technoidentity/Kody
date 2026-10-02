import {
	executeChild,
	proxyActivities,
	upsertSearchAttributes,
} from '@temporalio/workflow'
import {
	type KodyActivities,
	type PackageInvocationInput,
	type RunOutcome,
} from '../activities/types.ts'
import { taskQueues, workflowIds } from '../ids.ts'
import { kodySearchAttributes } from '../search-attributes.ts'

const { invokePackage } = proxyActivities<
	Pick<KodyActivities, 'invokePackage'>
>({
	startToCloseTimeout: '5 minutes',
	// User-code failures come back as `ok: false` outcomes; a throw means the
	// invocation never reached the package (idempotency ledger, transport),
	// which is safe to retry, as the queue redelivery was.
	retry: {
		initialInterval: '30 seconds',
		backoffCoefficient: 1,
		maximumAttempts: 10,
	},
})

/** Shared path for HTTP exports, webhooks and subscriptions. */
export async function PackageInvocation(
	input: PackageInvocationInput,
): Promise<RunOutcome> {
	const outcome = await invokePackage(input)
	upsertSearchAttributes([
		{
			key: kodySearchAttributes.status,
			value: outcome.ok ? 'completed' : 'failed',
		},
	])
	return outcome
}

/**
 * Run one `PackageInvocation` in `kody-exec`. A child workflow failure
 * (retries exhausted) becomes a failed outcome so siblings keep running.
 */
// ponytail: child workflow in the caller's namespace; becomes a Nexus operation into kody-exec when namespaces split.
export async function invokePackageChild(
	input: PackageInvocationInput,
): Promise<RunOutcome> {
	try {
		return await executeChild(PackageInvocation, {
			workflowId: workflowIds.packageInvocation(
				input.userId,
				input.surface,
				input.invocationKey,
			),
			taskQueue: taskQueues.runtime,
			args: [input],
			typedSearchAttributes: [
				{ key: kodySearchAttributes.userId, value: input.userId },
				{ key: kodySearchAttributes.surface, value: input.surface },
				{ key: kodySearchAttributes.packageId, value: input.packageId },
				{ key: kodySearchAttributes.status, value: 'running' },
			],
		})
	} catch (error) {
		return {
			runId: '',
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
