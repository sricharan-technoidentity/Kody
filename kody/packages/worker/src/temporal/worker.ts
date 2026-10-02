import { fileURLToPath } from 'node:url'
import {
	bundleWorkflowCode,
	type NativeConnection,
	Worker,
	type WorkflowBundleWithSourceMap,
} from '@temporalio/worker'
import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'
import { type KodyActivities } from './activities/types.ts'
import { createWorkflowIdempotencyActivities } from './idempotency.ts'
import {
	type KodyTemporal,
	kodyDataConverter,
	namespaceForTaskQueue,
	type KodyNamespaces,
} from './client.ts'
import { taskQueues, type TaskQueue } from './ids.ts'

const workflowsPath = fileURLToPath(
	new URL('./workflows/index.ts', import.meta.url),
)

const quietLogger = {
	log() {},
	trace() {},
	debug() {},
	info() {},
	warn: console.warn,
	error: console.error,
}

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined

/** One webpack bundle of every workflow, shared by all workers in the process. */
export function kodyWorkflowBundle() {
	return (bundle ??= bundleWorkflowCode({
		workflowsPath,
		logger: quietLogger,
		workflowInterceptorModules: [
			fileURLToPath(
				new URL('./workflows/idempotency-interceptor.ts', import.meta.url),
			),
		],
	}))
}

/**
 * One worker per task queue (`app`, `platform`, `runtime`, `ops`), each in
 * the namespace that owns its queue. Every worker registers every activity:
 * an activity runs on its workflow's queue, so a pool only executes its own
 * workflows' activities.
 */
// ponytail: all activities on every pool; split activity sets when the pools deploy separately.
export async function createKodyWorkers(input: {
	connection: NativeConnection
	namespaces: KodyNamespaces
	kms: KmsEnvelope
	activities: Partial<KodyActivities>
	queues?: ReadonlyArray<TaskQueue>
	temporal?: KodyTemporal
}): Promise<Array<Worker>> {
	const workflowBundle = await kodyWorkflowBundle()
	return Promise.all(
		(input.queues ?? Object.values(taskQueues)).map((taskQueue) => {
			const namespace = namespaceForTaskQueue(input.namespaces, taskQueue)
			return Worker.create({
				connection: input.connection,
				namespace,
				taskQueue,
				workflowBundle,
				activities: {
					...input.activities,
					...createWorkflowIdempotencyActivities({
						idempotency: input.temporal?.idempotency,
						results: input.temporal?.results,
						kms: input.kms,
						namespace,
					}),
				},
				dataConverter: kodyDataConverter({ kms: input.kms, namespace }),
			})
		}),
	)
}
