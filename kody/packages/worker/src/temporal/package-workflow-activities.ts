import { ApplicationFailure } from '@temporalio/common'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type JsonValue } from '@kody-internal/shared/json-safe-value.ts'
import { isAccountSuspendedError } from '#worker/account/account-suspension.ts'
import {
	PackageWorkflowExecutor,
	validateDynamicCallableWorkflowPayload,
	updateWorkflowRunStatus,
	type DynamicCallableWorkflowPayload,
} from '#worker/package-runtime/package-workflows.ts'
import { applyDynamicWorkflowSentryScope } from '#worker/package-runtime/package-workflows-sentry.ts'
import { getAccountEnv } from '#worker/identity/token-owner-db.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'

export type PackageWorkflowActivityInput = {
	id: string
	payload: DynamicCallableWorkflowPayload
}
export type PackageWorkflowActivities = {
	executePackageWorkflow(
		input: PackageWorkflowActivityInput,
	): Promise<JsonValue>
	projectPackageWorkflow(
		input: PackageWorkflowActivityInput & {
			status: string
			lastError?: string
			completedAt?: string
		},
	): Promise<void>
	recordPackageWorkflowUsage(
		input: PackageWorkflowActivityInput & {
			startedAtMs: number
			outcome: 'success' | 'error'
		},
	): Promise<void>
}

export function createPackageWorkflowActivities(
	env: Env,
): PackageWorkflowActivities {
	return {
		async executePackageWorkflow(input) {
			const payload = validateDynamicCallableWorkflowPayload(input.payload)
			applyDynamicWorkflowSentryScope({ payload, instanceId: input.id })
			const pending: Array<Promise<unknown>> = []
			const executor = new PackageWorkflowExecutor(
				{
					waitUntil: (promise) => {
						pending.push(promise)
					},
				},
				getAccountEnv(env, payload.userId),
			)
			try {
				return payload.sourceType === 'package'
					? await executor.invokePackageWorkflowExport(payload, input.id)
					: await executor.invokeInlineWorkflowCode(payload, input.id)
			} catch (error) {
				if (isAccountSuspendedError(error)) {
					throw ApplicationFailure.nonRetryable(
						getErrorMessage(error),
						'AccountSuspendedError',
					)
				}
				throw error
			} finally {
				await Promise.allSettled(pending)
			}
		},
		async projectPackageWorkflow({ id, payload, ...status }) {
			await updateWorkflowRunStatus({ env, id, payload, ...status })
		},
		async recordPackageWorkflowUsage({ id, payload, startedAtMs, outcome }) {
			await recordUsage(getAccountEnv(env, payload.userId), {
				userId: payload.userId,
				eventType: 'workflow_run',
				entityId: id,
				durationMs: Date.now() - startedAtMs,
				outcome,
			})
		},
	}
}
