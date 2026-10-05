import { createExecutorModuleSource } from '#mcp/executor.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { createHash } from 'node:crypto'
import { type FetchGatewayProps } from '#worker/egress/proxy.ts'
import {
	type RunnerLoader,
	type RunnerDispatcher,
} from '#worker/runner/loader.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import {
	runnerInputKey,
	RunnerInvocationError,
	claimRunnerDispatch,
} from '#worker/runner/contract.ts'
import { runnerSessionId } from '#worker/aws/agentcore-runner.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { ApplicationFailure } from '@temporalio/common'
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import { Context } from '@temporalio/activity'
import { type AwsEnv } from '#worker/aws/env.ts'
import { runErrorRecordedTopic } from '#worker/run-records/package-subscriptions.ts'
import { taskQueues, workflowIds } from '../ids.ts'
import { kodySearchAttributes } from '../search-attributes.ts'
import { type EventFanout } from '../workflows/event-fanout.ts'
import { type KodyActivities, type RunOutcome } from './types.ts'

/** The `execute` result cap (bytes of UTF-8). */
export const executeResultCapBytes = 100 * 1024

type SandboxRun = {
	userId: string
	runId: string
	surface: string
	payload: Record<string, unknown>
	maxOutputBytes?: number
}

function logicalRunId(...identity: Array<string>) {
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function capUtf8(value: string, maxBytes: number) {
	const bytes = new TextEncoder().encode(value)
	if (bytes.length <= maxBytes) return value
	return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�$/, '')
}

/**
 * The target slice's activities over the AWS ports of {@link AwsEnv}
 * (meters, Runner, run records, code interpreter, S3, search index).
 * Acceptance tests run every workflow against these.
 */
export function createTargetActivities(
	env: AwsEnv,
	options: {
		now?: () => number
		/** Trusted application preparation, never a package-supplied graph or owner. */
		runner?: {
			loader: RunnerLoader
			resolve(input: SandboxRun): Promise<{
				context: FetchGatewayProps
				graph: RunnerGraph
				dispatchers?: Record<string, RunnerDispatcher>
			}>
		}
	} = {},
) {
	async function consumeMeter(input: { userId: string; counter: string }) {
		try {
			env.kv.update(
				`${input.userId}:meters`,
				input.counter,
				(item) => ({ ...item!, remaining: Number(item!.remaining) - 1 }),
				(item) => Number(item?.['remaining'] ?? 0) > 0,
			)
		} catch (error) {
			if (error instanceof Error && error.message.includes('conditional')) {
				throw ApplicationFailure.nonRetryable(
					`The ${input.counter} entitlement is spent for today.`,
					'EntitlementExceeded',
				)
			}
			throw error
		}
	}

	async function runSandbox(input: SandboxRun): Promise<RunOutcome> {
		let response: { output?: unknown; result?: unknown; error?: unknown }
		let dispatched = false
		try {
			if (options.runner) {
				const { context, graph, dispatchers } =
					await options.runner.resolve(input)
				if (context.userId !== input.userId)
					throw ApplicationFailure.nonRetryable(
						'Runner preparation owner mismatch.',
					)
				response = (await options.runner.loader
					.forContext(context)
					.invokeGraph(
						{ ...graph, surface: input.surface },
						dispatchers,
						input.runId,
					)) as typeof response
				dispatched = true
			} else {
				// The AWS-port acceptance adapter is simulated; opt-in real execution uses the shared loader above.
				const graph =
					input.surface === 'execute'
						? {
								...createDynamicWorkerCompatibilityOptions(),
								mainModule: 'executor.js',
								providers: [],
								surface: input.surface,
								method: 'evaluate',
								invocation: {},
								modules: {
									'executor.js': createExecutorModuleSource({
										code: String(input.payload.code),
										providers: [],
										shadowGlobalThis: true,
										timeoutMs: 60_000,
									}),
								},
							}
						: { ...input.payload, surface: input.surface }
				const bytes = new TextEncoder().encode(JSON.stringify(graph))
				const bundleKey = runnerInputKey(input.userId, input.runId)
				env.objects.put(bundleKey, bytes)
				const packageId =
					typeof input.payload.packageId === 'string'
						? input.payload.packageId
						: null
				const runToken = await mintRunToken(env.RUN_TOKEN_SIGNING_KEY, {
					userId: input.userId,
					runId: input.runId,
					expiresAt: Date.now() + 90_000,
					retriever: input.surface === 'retriever',
					provenance: [
						{
							moduleId: 'main',
							packageId,
							storageId: packageId
								? buildPackageStorageId(packageId)
								: `exec:${input.runId}`,
						},
					],
				})
				dispatched = true
				if (!env.TEMPORAL.idempotency)
					throw ApplicationFailure.nonRetryable(
						'Missing Runner dispatch ledger.',
					)
				await claimRunnerDispatch(
					env.TEMPORAL.idempotency,
					input.userId,
					input.runId,
				)
				response = (await env.runner.invoke({
					runtimeSessionId: runnerSessionId(input.userId, input.runId),
					payload: {
						runId: input.runId,
						bundleKey,
						runToken,
					},
				})) as typeof response
			}
		} catch (error) {
			if (error instanceof RunnerInvocationError) dispatched = error.dispatched
			if (!dispatched) throw error
			return {
				runId: input.runId,
				ok: false,
				error: `Runner failed after dispatch; execution may have completed: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
		if (typeof response.error === 'string') {
			return { runId: input.runId, ok: false, error: response.error }
		}
		const output =
			typeof response.output === 'string'
				? response.output
				: JSON.stringify(response.output ?? response.result ?? null)
		return {
			runId: input.runId,
			ok: true,
			output: capUtf8(output, input.maxOutputBytes ?? Number.POSITIVE_INFINITY),
		}
	}

	/** Run row first; an error run then fans `run.error.recorded` out. */
	async function recordRun(input: {
		userId: string
		surface: string
		outcome: RunOutcome
	}) {
		const { outcome } = input
		env.kv.put({
			pk: `${input.userId}:runs`,
			sk: outcome.runId,
			surface: input.surface,
			status: outcome.ok ? 'success' : 'error',
			...(outcome.ok ? {} : { error: outcome.error }),
			finishedAt: new Date().toISOString(),
		})
		if (outcome.ok || input.surface === 'subscription') return
		const client = await env.TEMPORAL.client(taskQueues.platform)
		try {
			await client.workflow.start<typeof EventFanout>('EventFanout', {
				workflowId: workflowIds.eventFanout(
					runErrorRecordedTopic,
					outcome.runId,
				),
				taskQueue: taskQueues.platform,
				args: [
					{
						userId: input.userId,
						topic: runErrorRecordedTopic,
						eventId: outcome.runId,
						payload: {
							runId: outcome.runId,
							surface: input.surface,
							error: outcome.error,
						},
					},
				],
				typedSearchAttributes: [
					{ key: kodySearchAttributes.userId, value: input.userId },
					{ key: kodySearchAttributes.surface, value: 'event' },
				],
			})
		} catch (error) {
			// A retried activity already started this event's fan-out.
			if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
		}
	}

	async function finishRun(
		userId: string,
		surface: string,
		outcome: RunOutcome,
	) {
		try {
			await recordRun({ userId, surface, outcome })
		} catch (error) {
			throw ApplicationFailure.nonRetryable(
				`Runner completed but outcome recording failed: ${error instanceof Error ? error.message : String(error)}`,
				'RunnerOutcomeRecordingFailed',
			)
		}
		return outcome
	}

	return {
		consumeMeter,

		async executeCode(input) {
			const outcome = await runSandbox({
				userId: input.userId,
				runId: input.runId,
				surface: 'execute',
				payload: { requestId: input.requestId, code: input.code },
				maxOutputBytes: executeResultCapBytes,
			})
			return finishRun(input.userId, 'execute', outcome)
		},

		async invokePackage(input) {
			const outcome = await runSandbox({
				userId: input.userId,
				runId: logicalRunId(input.userId, input.surface, input.invocationKey),
				surface: input.surface,
				payload: {
					packageId: input.packageId,
					exportName: input.exportName,
					params: input.params,
				},
			})
			return finishRun(input.userId, input.surface, outcome)
		},

		async listEventSubscribers(event) {
			return env.kv
				.query(`${event.userId}:subscriptions`, `${event.topic}#`)
				.map((item) => ({
					userId: event.userId,
					packageId: String(item['packageId']),
					exportName:
						typeof item['exportName'] === 'string' ? item['exportName'] : null,
				}))
		},

		async admitWebhookDelivery(input) {
			const now = (options.now ?? Date.now)()
			const minute = Math.floor(now / 60_000)
			try {
				env.kv.update(
					`${input.userId}:webhook-rate`,
					`${input.endpointId}#${minute}`,
					(item) => ({
						pk: `${input.userId}:webhook-rate`,
						sk: `${input.endpointId}#${minute}`,
						count: Number(item?.['count'] ?? 0) + 1,
						expiresAt: (minute + 2) * 60_000,
					}),
					(item) => Number(item?.['count'] ?? 0) < input.rateLimitPerMinute,
				)
				return { admitted: true }
			} catch (error) {
				if (error instanceof Error && error.message.includes('conditional')) {
					return {
						admitted: false,
						retryAfterSeconds: Math.ceil(((minute + 1) * 60_000 - now) / 1_000),
					}
				}
				throw error
			}
		},

		async runJob(input) {
			const info = Context.current().info
			if (!info.workflowExecution)
				throw ApplicationFailure.nonRetryable(
					'Job requires a workflow execution identity.',
				)
			await consumeMeter({ userId: input.userId, counter: 'job_runs_per_day' })
			const outcome = await runSandbox({
				userId: input.userId,
				runId: logicalRunId(
					input.userId,
					'job',
					info.workflowExecution.runId,
					info.activityId,
				),
				surface: 'job',
				payload: { jobId: input.jobId, scheduledAt: input.scheduledAt },
			})
			return finishRun(input.userId, 'job', outcome)
		},

		async runPublishCheck(input) {
			return env.interpreter.run(input.check)
		},

		async storePackageBundle(input) {
			const bundle = env.interpreter.readFile('dist/bundle.js')
			if (!bundle) {
				throw ApplicationFailure.nonRetryable(
					'The bundle check left no dist/bundle.js in the session.',
				)
			}
			const bundleKey = `${input.userId}/bundles/${input.packageId}/${input.commit}.js`
			env.objects.put(bundleKey, bundle)
			return { bundleKey }
		},

		async reindexPackage(input) {
			const [values] = await env.BEDROCK_EMBEDDINGS.embedTexts([
				`${input.packageId}@${input.commit}`,
			])
			await env.SEARCH_INDEX.upsert([
				{
					id: `package_${input.packageId}`,
					values: values!,
					metadata: { kind: 'package', userId: input.userId },
				},
			])
		},

		async advancePublishedCommit(input) {
			env.kv.put({
				pk: `${input.userId}:packages`,
				sk: input.packageId,
				publishedCommit: input.commit,
				bundleKey: input.bundleKey,
			})
		},
	} satisfies Partial<KodyActivities>
}
