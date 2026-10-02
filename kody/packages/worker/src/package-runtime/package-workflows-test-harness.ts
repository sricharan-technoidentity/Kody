// Direct activity behaviour harness: real durability is checked on the Temporal test server.
import { ApplicationFailure } from '@temporalio/common'
import { type JsonValue } from '@kody-internal/shared/json-safe-value.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isAccountSuspendedError } from '#worker/account/account-suspension.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { applyDynamicWorkflowSentryScope } from './package-workflows-sentry.ts'
import {
	PackageWorkflowExecutor,
	validateDynamicCallableWorkflowPayload,
	updateWorkflowRunStatus,
	type DynamicCallableWorkflowPayload,
} from './package-workflows.ts'
type WorkflowStepDoConfig = {
	retries?: {
		limit: number
		delay: string | number
		backoff?: string
	}
	timeout?: string | number
}

const workflowStepDoConfig: WorkflowStepDoConfig = {
	retries: {
		limit: 3,
		delay: '30 seconds',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
}

type DynamicCallableWorkflowStep = {
	do(
		name: string,
		config: WorkflowStepDoConfig,
		callback: () => Promise<JsonValue>,
	): Promise<JsonValue>
}

export class DynamicCallableWorkflowBase extends PackageWorkflowExecutor {
	async run(
		event: Readonly<{
			payload: DynamicCallableWorkflowPayload
			instanceId: string
		}>,
		step: DynamicCallableWorkflowStep & {
			sleepUntil(name: string, date: Date): Promise<void>
		},
	) {
		const payload = validateDynamicCallableWorkflowPayload(event.payload)
		applyDynamicWorkflowSentryScope({
			payload,
			instanceId: event.instanceId,
		})
		const runAt = new Date(payload.runAt)
		if (runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait until dynamic workflow runAt', runAt)
		}
		const typedStep = step as unknown as DynamicCallableWorkflowStep
		// Captured inside a step so replays after interruption reuse the original
		// start time. The clock starts after the scheduled runAt sleep so a
		// workflow queued days ahead does not record days of "runtime".
		const startedAtMs = Number(
			await typedStep.do(
				'capture usage start time',
				workflowStepDoConfig,
				async () => Date.now(),
			),
		)
		await typedStep.do(
			'mark workflow running',
			workflowStepDoConfig,
			async () => {
				await updateWorkflowRunStatus({
					env: this.env,
					id: event.instanceId,
					payload,
					status: 'running',
				})
				return { ok: true }
			},
		)
		let result: JsonValue
		try {
			result = await typedStep.do(
				payload.sourceType === 'package'
					? 'invoke saved package workflow export'
					: 'execute inline workflow code',
				workflowStepDoConfig,
				async () => {
					try {
						if (payload.sourceType === 'package') {
							return await this.invokePackageWorkflowExport(
								payload,
								event.instanceId,
							)
						}
						return await this.invokeInlineWorkflowCode(
							payload,
							event.instanceId,
						)
					} catch (error) {
						// Suspension stays in force across step retries, so fail the
						// step once instead of waiting out the retry backoff.
						if (isAccountSuspendedError(error)) {
							throw ApplicationFailure.nonRetryable(error.message, error.name)
						}
						throw error
					}
				},
			)
		} catch (error) {
			await updateWorkflowRunStatus({
				env: this.env,
				id: event.instanceId,
				payload,
				status: 'errored',
				lastError: getErrorMessage(error),
				completedAt: new Date().toISOString(),
			})
			await this.recordWorkflowRunUsage({
				typedStep,
				payload,
				instanceId: event.instanceId,
				startedAtMs,
				outcome: 'error',
			})
			throw error
		}
		// The catch above only wraps workflow execution: a failing terminal
		// status write must not relabel a successful run as an error.
		await updateWorkflowRunStatus({
			env: this.env,
			id: event.instanceId,
			payload,
			status: 'complete',
			completedAt: new Date().toISOString(),
		})
		await this.recordWorkflowRunUsage({
			typedStep,
			payload,
			instanceId: event.instanceId,
			startedAtMs,
			outcome: 'success',
		})
		return result
	}

	private async recordWorkflowRunUsage(input: {
		typedStep: DynamicCallableWorkflowStep
		payload: DynamicCallableWorkflowPayload
		instanceId: string
		startedAtMs: number
		outcome: 'success' | 'error'
	}) {
		if (!input.payload.userId) return
		// Emitted inside a step so a replayed run() returns the cached result
		// instead of recording the event again. The outcome is part of the step
		// name so cached results from one path can never shadow the other.
		await input.typedStep.do(
			`record workflow usage (${input.outcome})`,
			workflowStepDoConfig,
			async () => {
				await recordUsage(this.env, {
					userId: input.payload.userId,
					eventType: 'workflow_run',
					entityId: input.instanceId,
					durationMs: Date.now() - input.startedAtMs,
					outcome: input.outcome,
				})
				return { ok: true }
			},
		)
	}
}
