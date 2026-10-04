import { type PgDatabase } from './pg-database.ts'
import { type EmbeddingPort } from './bedrock-embeddings.ts'
import { type createPgSearchIndex } from './pg-search-index.ts'
import { type KodyTemporal } from '#worker/temporal/client.ts'

import { type createStorageCells } from '#worker/storage-cell/storage-cell.ts'

type KvItem = { pk: string; sk: string; [key: string]: unknown }

export type AwsEnv = {
	userId: string
	STORAGE_CELLS: ReturnType<typeof createStorageCells>
	AWS_REGION: string
	AWS_ACCESS_KEY_ID: string
	AWS_SECRET_ACCESS_KEY: string
	AWS_ACCOUNT_ID: string
	DATABASE_WRITER_URL: string
	DATABASE_READER_URL: string
	AUDIT_DATABASE_WRITER_URL: string
	AUDIT_DATABASE_READER_URL: string
	DYNAMO_TABLE_METERS: string
	DYNAMO_TABLE_OAUTH: string
	DYNAMO_TABLE_RUNS: string
	DYNAMO_TABLE_IDEMPOTENCY: string
	DYNAMO_TABLE_LEASES: string
	S3_BUCKET_BUNDLES: string
	S3_BUCKET_BLOBS: string
	KMS_KEY_ID: string
	TEMPORAL_ADDRESS: string
	TEMPORAL_NAMESPACE_CORE: string
	TEMPORAL_NAMESPACE_EXEC: string
	TEMPORAL_NAMESPACE_OPS: string
	AGENTCORE_RUNNER_ARN: string
	AGENTCORE_MCP_ARN: string
	AGENTCORE_CODE_INTERPRETER_ID: string
	AGENTCORE_IDENTITY_WORKLOAD: string
	RUN_TOKEN_SIGNING_KEY: string
	BEDROCK_EMBEDDING_MODEL_ID: string
	SES_FROM_DOMAIN: string
	APP_DB: PgDatabase
	APP_DB_READER: PgDatabase
	AUDIT_DB: PgDatabase
	AUDIT_DB_READER: PgDatabase
	SEARCH_INDEX: ReturnType<typeof createPgSearchIndex>
	BEDROCK_EMBEDDINGS: EmbeddingPort
	db: PgDatabase
	reader: PgDatabase
	/** Front door and MCP server write only through Temporal. */
	TEMPORAL: KodyTemporal
	kv: {
		get(pk: string, sk: string): KvItem | undefined
		put(
			item: KvItem,
			condition?: (current: KvItem | undefined) => boolean,
		): void
		update(
			pk: string,
			sk: string,
			update: (current: KvItem | undefined) => KvItem,
			condition?: (current: KvItem | undefined) => boolean,
		): void
		query(pk: string, sortPrefix?: string): Array<KvItem>
	}
	objects: {
		get(key: string): Uint8Array | undefined
		put(key: string, value: Uint8Array): void
	}
	kms: {
		encrypt(
			value: Uint8Array,
			context: Record<string, string>,
		): Promise<Uint8Array>
		decrypt(
			value: Uint8Array,
			context: Record<string, string>,
		): Promise<Uint8Array>
	}
	vault: {
		fetch(
			userId: string,
			provider: string,
			workload: string,
		): string | undefined
	}
	runner: {
		invoke(input: {
			runtimeSessionId: string
			payload: unknown
		}): Promise<unknown>
	}
	interpreter: {
		run(
			check: 'bundle' | 'typecheck' | 'lint',
		): Promise<{ ok: boolean; output: string }>
		readFile(path: string): Uint8Array | undefined
	}
	ses: {
		send(mail: {
			from: string
			to: string
			subject: string
			body: string
		}): Promise<void>
	}
}
