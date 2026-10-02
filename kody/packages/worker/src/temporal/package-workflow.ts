import { type DynamicCallableWorkflowPayload } from '#worker/package-runtime/package-workflows.ts'
import { type KodyTemporal } from './client.ts'
import { taskQueues } from './ids.ts'
import { startKodyWorkflow } from './start.ts'

export type PackageWorkflowInstance = {
	id: string
	status(): Promise<{ status?: string }>
	terminate(): Promise<void>
}
export type PackageWorkflowEngine = {
	get(id: string): Promise<PackageWorkflowInstance>
	create(input: {
		id: string
		params: DynamicCallableWorkflowPayload
		retention?: { successRetention: string; errorRetention: string }
	}): Promise<PackageWorkflowInstance>
}

/** Compatibility shape for the existing create, inspection and cancel APIs. */
export function createTemporalPackageWorkflowBinding(
	temporal: KodyTemporal,
): PackageWorkflowEngine {
	async function get(id: string) {
		const client = await temporal.client(taskQueues.runtime)
		const handle = client.workflow.getHandle(id)
		await handle.describe()
		return {
			id,
			async status() {
				const description = await handle.describe()
				const statuses: Record<string, string> = {
					RUNNING: 'running',
					COMPLETED: 'complete',
					FAILED: 'errored',
					CANCELLED: 'cancelled',
					TERMINATED: 'terminated',
					TIMED_OUT: 'errored',
				}
				return { status: statuses[description.status.name] ?? 'unknown' }
			},
			async terminate() {
				await handle.cancel()
				// Wait for cancellation to settle before releasing the entitlement slot.
				try {
					await handle.result()
				} catch {
					// The terminal status below decides whether cancellation won.
				}
				const description = await handle.describe()
				if (description.status.name !== 'CANCELLED') {
					throw new Error(
						`Workflow is already ${description.status.name.toLowerCase()}.`,
					)
				}
			},
		}
	}
	return {
		get,
		// ponytail: retention is namespace-wide; P7 configures 30-day history retention.
		async create(input: {
			id: string
			params: DynamicCallableWorkflowPayload
		}) {
			await startKodyWorkflow(temporal, {
				workflowType: 'PackageWorkflowRun',
				workflowId: input.id,
				taskQueue: taskQueues.runtime,
				args: [input.params],
				userId: input.params.userId,
				surface: 'workflow',
				...(input.params.sourceType === 'package'
					? { packageId: input.params.packageId }
					: {}),
			})
			return get(input.id)
		},
	}
}
