import temporalProto from '@temporalio/proto'
const proto = temporalProto.temporal
import {
	TestWorkflowEnvironment,
	type LocalTestWorkflowEnvironmentOptions,
} from '@temporalio/testing'
import { Runtime, Worker } from '@temporalio/worker'
import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'
import { type KodyActivities } from '#worker/temporal/activities/types.ts'
import {
	kodyDataConverter,
	type KodyNamespaces,
	type KodyTemporal,
} from '#worker/temporal/client.ts'
import { type TaskQueue } from '#worker/temporal/ids.ts'
import { kodySearchAttributeKeys } from '#worker/temporal/search-attributes.ts'
import {
	createKodyWorkers,
	kodyWorkflowBundle,
} from '#worker/temporal/worker.ts'
import { createFakeKms } from './fake-kms.ts'
import { createFakeDynamo } from './fake-dynamo.ts'
import { createTestObjectBucket } from './fake-s3.ts'
import { createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { createWorkflowIdempotencyActivities } from '#worker/temporal/idempotency.ts'

let runtimeInstalled = false
function installQuietRuntime() {
	if (runtimeInstalled) return
	runtimeInstalled = true
	try {
		Runtime.install({
			shutdownSignals: [],
			logger: {
				log() {},
				trace() {},
				debug() {},
				info() {},
				warn() {},
				error: console.error,
			},
		})
	} catch {
		// Already installed by an earlier environment in this process.
	}
}

/**
 * Local Temporal for tests. The default is the dev server (Schedules,
 * Visibility and Kody's search attributes; real time). `timeSkipping`
 * uses the test server, which skips timers but has no Schedules.
 * Every client and worker uses Kody's KMS payload codec.
 */
export async function createTemporalEnv(
	options: {
		timeSkipping?: boolean
		server?: LocalTestWorkflowEnvironmentOptions['server']
		kms?: KmsEnvelope
		idempotency?: KodyTemporal['idempotency']
		results?: KodyTemporal['results']
	} = {},
) {
	installQuietRuntime()
	const kms = options.kms ?? createFakeKms()
	// Both test servers start in the `default` namespace; the env's own
	// client is required for time skipping, so it carries the codec.
	const namespace = 'default'
	const client = { dataConverter: kodyDataConverter({ kms, namespace }) }
	const test = options.timeSkipping
		? await TestWorkflowEnvironment.createTimeSkipping({
				client,
				server: process.env.KODY_TEMPORAL_TEST_EXECUTABLE
					? {
							executable: {
								type: 'existing-path',
								path: process.env.KODY_TEMPORAL_TEST_EXECUTABLE,
							},
						}
					: undefined,
			})
		: await TestWorkflowEnvironment.createLocal({
				client,
				server: {
					ip: '127.0.0.1',
					...(process.env.KODY_TEMPORAL_EXECUTABLE
						? {
								executable: {
									type: 'existing-path',
									path: process.env.KODY_TEMPORAL_EXECUTABLE,
								},
							}
						: {}),
					...options.server,
					searchAttributes: kodySearchAttributeKeys,
				},
			})
	if (options.timeSkipping) {
		// The test server has no CLI flag for these; register them directly.
		await test.connection.operatorService.addSearchAttributes({
			namespace,
			searchAttributes: Object.fromEntries(
				kodySearchAttributeKeys.map((key) => [
					key.name,
					proto.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
				]),
			),
		})
	}
	const namespaces: KodyNamespaces = {
		core: namespace,
		exec: namespace,
		ops: namespace,
	}
	const temporal: KodyTemporal = {
		client: async () => test.client,
		idempotency:
			options.idempotency ??
			createDynamoIdempotency({
				region: 'us-east-1',
				idempotencyTable: 'test-idempotency',
				send: createFakeDynamo().send,
			}),
		results: options.results ?? createTestObjectBucket().bucket,
	}
	const workers: Array<Worker> = []
	const running: Array<Promise<void>> = []
	let lastInput:
		| { activities: Partial<KodyActivities>; queues?: ReadonlyArray<TaskQueue> }
		| undefined
	async function stopWorkers() {
		for (const worker of workers.splice(0)) worker.shutdown()
		await Promise.all(running.splice(0))
	}
	const run = (started: Array<Worker>) => {
		for (const worker of started) {
			workers.push(worker)
			running.push(worker.run())
		}
		return started
	}
	return {
		/** Client in the test namespace, with the KMS codec. */
		client: test.client,
		address: test.address,
		temporal,
		async restartWorkers() {
			await stopWorkers()
			if (lastInput) await this.startWorkers(lastInput)
		},
		/** Kody workers for the given queues (default: all four). */
		async startWorkers(input: {
			activities: Partial<KodyActivities>
			queues?: ReadonlyArray<TaskQueue>
		}) {
			lastInput = input
			return run(
				await createKodyWorkers({
					connection: test.nativeConnection,
					namespaces,
					kms,
					activities: input.activities,
					queues: input.queues,
					temporal,
				}),
			)
		},
		/** A worker on any queue name (P2 harness and ad-hoc tests). */
		async startWorker(input: {
			taskQueue: string
			activities?: Record<string, (...args: never[]) => unknown>
		}) {
			const worker = await Worker.create({
				connection: test.nativeConnection,
				namespace,
				taskQueue: input.taskQueue,
				workflowBundle: await kodyWorkflowBundle(),
				activities: {
					...input.activities,
					...createWorkflowIdempotencyActivities({
						idempotency: temporal.idempotency,
						results: temporal.results,
						kms,
						namespace,
					}),
				},
				dataConverter: kodyDataConverter({ kms, namespace }),
			})
			return run([worker])[0]!
		},
		async close() {
			try {
				await stopWorkers()
			} finally {
				await test.teardown()
			}
		},
	}
}

export type TemporalTestEnv = Awaited<ReturnType<typeof createTemporalEnv>>
