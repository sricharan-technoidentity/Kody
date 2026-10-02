import { Client, Connection } from '@temporalio/client'
import { type DataConverter } from '@temporalio/common'
import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'
import { createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { type RunLogObjects } from '#worker/run-records/run-log-types.ts'
import { createKodyPayloadCodec } from './codec.ts'
import { taskQueues, type TaskQueue } from './ids.ts'

export type KodyNamespaces = { core: string; exec: string; ops: string }

/** Namespace that owns each task queue (target doc "Namespaces" table). */
export function namespaceForTaskQueue(
	namespaces: KodyNamespaces,
	taskQueue: TaskQueue,
) {
	switch (taskQueue) {
		case taskQueues.app:
		case taskQueues.platform:
			return namespaces.core
		case taskQueues.runtime:
			return namespaces.exec
		case taskQueues.ops:
			return namespaces.ops
		default:
			throw new Error(`Unknown Kody task queue "${String(taskQueue)}".`)
	}
}

export function kodyDataConverter(input: {
	kms: KmsEnvelope
	namespace: string
}): DataConverter {
	return { payloadCodecs: [createKodyPayloadCodec(input)] }
}

/**
 * The only write path of the front door and the MCP server: every mutation
 * is a Start, Signal or Update through one of these clients.
 */
export type KodyTemporal = {
	client(taskQueue: TaskQueue): Promise<Client>
	idempotency?: ReturnType<typeof createDynamoIdempotency>
	results?: RunLogObjects
}

export function createKodyTemporal(input: {
	connection: Connection
	namespaces: KodyNamespaces
	kms: KmsEnvelope
	idempotency?: ReturnType<typeof createDynamoIdempotency>
	results?: RunLogObjects
}): KodyTemporal {
	const clients = new Map<string, Client>()
	return {
		idempotency: input.idempotency,
		results: input.results,
		async client(taskQueue) {
			const namespace = namespaceForTaskQueue(input.namespaces, taskQueue)
			let client = clients.get(namespace)
			if (!client) {
				client = new Client({
					connection: input.connection,
					namespace,
					dataConverter: kodyDataConverter({ kms: input.kms, namespace }),
				})
				clients.set(namespace, client)
			}
			return client
		},
	}
}

/** Production wiring from the section-3 environment (lazy connection). */
export function createKodyTemporalFromEnv(env: {
	TEMPORAL_ADDRESS: string
	TEMPORAL_NAMESPACE_CORE: string
	TEMPORAL_NAMESPACE_EXEC: string
	TEMPORAL_NAMESPACE_OPS: string
	kms: KmsEnvelope
	AWS_REGION: string
	DYNAMO_TABLE_IDEMPOTENCY: string
	S3_BUCKET_BLOBS: string
}): KodyTemporal {
	// ponytail: plaintext gRPC; Temporal Cloud over PrivateLink needs mTLS/API-key options here.
	return createKodyTemporal({
		connection: Connection.lazy({ address: env.TEMPORAL_ADDRESS }),
		namespaces: {
			core: env.TEMPORAL_NAMESPACE_CORE,
			exec: env.TEMPORAL_NAMESPACE_EXEC,
			ops: env.TEMPORAL_NAMESPACE_OPS,
		},
		kms: env.kms,
		idempotency: createDynamoIdempotency({
			region: env.AWS_REGION,
			idempotencyTable: env.DYNAMO_TABLE_IDEMPOTENCY,
		}),
		results: createS3Objects({
			region: env.AWS_REGION,
			bucket: env.S3_BUCKET_BLOBS,
		}),
	})
}
