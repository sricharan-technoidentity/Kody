import { randomUUID } from 'node:crypto'
import { ApplicationFailure } from '@temporalio/common'
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import { type AwsEnv } from '#worker/aws/env.ts'
import { runErrorRecordedTopic } from '#worker/run-records/package-subscriptions.ts'
import { taskQueues, workflowIds } from '../ids.ts'
import { kodySearchAttributes } from '../search-attributes.ts'
import { type EventFanout } from '../workflows/event-fanout.ts'
import { type KodyActivities, type RunOutcome } from './types.ts'

/** The `execute` result cap (bytes of UTF-8). */
export const executeResultCapBytes = 100 * 1024

/** Kept in the session for the Runner; ≥33 characters (AgentCore limit). */
// ponytail: P6 replaces this with hash(stable_user_id + rotation epoch) in aws/agentcore-runner.ts.
export function runnerSessionId(userId: string) {
	return `${userId}:runner`.padEnd(33, '0')
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
export function createTargetActivities(env: AwsEnv) {
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

	async function runSandbox(input: {
		userId: string
		runId: string
		surface: string
		payload: Record<string, unknown>
		maxOutputBytes?: number
	}): Promise<RunOutcome> {
		let response: { output?: unknown; error?: unknown }
		try {
			response = (await env.runner.invoke({
				runtimeSessionId: runnerSessionId(input.userId),
				payload: {
					runId: input.runId,
					surface: input.surface,
					...input.payload,
				},
			})) as typeof response
		} catch (error) {
			return {
				runId: input.runId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
		if (typeof response.error === 'string') {
			return { runId: input.runId, ok: false, error: response.error }
		}
		const output =
			typeof response.output === 'string'
				? response.output
				: JSON.stringify(response.output ?? null)
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
			await recordRun({ userId: input.userId, surface: 'execute', outcome })
			return outcome
		},

		async invokePackage(input) {
			const outcome = await runSandbox({
				userId: input.userId,
				runId: randomUUID(),
				surface: input.surface,
				payload: {
					packageId: input.packageId,
					exportName: input.exportName,
					params: input.params,
				},
			})
			await recordRun({ userId: input.userId, surface: input.surface, outcome })
			return outcome
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
			const now = Date.now()
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
			await consumeMeter({ userId: input.userId, counter: 'job_runs_per_day' })
			const outcome = await runSandbox({
				userId: input.userId,
				runId: randomUUID(),
				surface: 'job',
				payload: { jobId: input.jobId, scheduledAt: input.scheduledAt },
			})
			await recordRun({ userId: input.userId, surface: 'job', outcome })
			return outcome
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
