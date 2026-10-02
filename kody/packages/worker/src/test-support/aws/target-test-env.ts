import { createFakeCodeInterpreter } from './fake-code-interpreter.ts'
import { type AwsEnv } from '../../aws/env.ts'
import { createFakeKms } from './fake-kms.ts'
import { createFakeKvTable } from './fake-kv-table.ts'
import { createFakeObjectStore } from './fake-object-store.ts'
import { createFakeRunner } from './fake-runner.ts'
import { createFakeSes } from './fake-ses.ts'
import { createFakeTokenVault } from './fake-token-vault.ts'
import { createTemporalEnv, type TemporalTestEnv } from './temporal-env.ts'
import { createTestDb } from './test-db.ts'
import { createTestAuditDb } from './test-audit-db.ts'
import { createPgSearchIndex } from '#worker/aws/pg-search-index.ts'
import { deterministicEmbedding } from '#worker/search-index/embedding.ts'
import { createTargetActivities } from '#worker/temporal/activities/target.ts'
import { type KodyTemporal } from '#worker/temporal/client.ts'
import { createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { createFakeDynamo } from './fake-dynamo.ts'
import { createTestObjectBucket } from './fake-s3.ts'

export async function createTargetTestEnv(options: { userId?: string } = {}) {
	const database = await createTestDb(options)
	const audit = await createTestAuditDb().catch(async (error: unknown) => {
		await database[Symbol.asyncDispose]()
		throw error
	})
	const mockValue = (name: string, fallback: string) =>
		process.env[name] ?? fallback
	const env = {
		AWS_REGION: mockValue('AWS_REGION', 'us-east-1'),
		AWS_ACCESS_KEY_ID: mockValue('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'),
		AWS_SECRET_ACCESS_KEY: mockValue(
			'AWS_SECRET_ACCESS_KEY',
			'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		),
		AWS_ACCOUNT_ID: mockValue('AWS_ACCOUNT_ID', '000000000000'),
		DATABASE_WRITER_URL: mockValue(
			'DATABASE_WRITER_URL',
			'postgres://kody_writer:mock@localhost:5432/kody',
		),
		DATABASE_READER_URL: mockValue(
			'DATABASE_READER_URL',
			'postgres://kody_reader:mock@localhost:5432/kody',
		),
		AUDIT_DATABASE_WRITER_URL: mockValue(
			'AUDIT_DATABASE_WRITER_URL',
			'postgres://kody_audit_writer:mock@localhost:5432/kody_audit',
		),
		AUDIT_DATABASE_READER_URL: mockValue(
			'AUDIT_DATABASE_READER_URL',
			'postgres://kody_audit_reader:mock@localhost:5432/kody_audit',
		),
		DYNAMO_TABLE_METERS: mockValue('DYNAMO_TABLE_METERS', 'kody-test-meters'),
		DYNAMO_TABLE_OAUTH: mockValue('DYNAMO_TABLE_OAUTH', 'kody-test-oauth'),
		DYNAMO_TABLE_RUNS: mockValue('DYNAMO_TABLE_RUNS', 'kody-test-runs'),
		DYNAMO_TABLE_IDEMPOTENCY: mockValue(
			'DYNAMO_TABLE_IDEMPOTENCY',
			'kody-test-idempotency',
		),
		DYNAMO_TABLE_LEASES: mockValue('DYNAMO_TABLE_LEASES', 'kody-test-leases'),
		S3_BUCKET_BUNDLES: mockValue('S3_BUCKET_BUNDLES', 'kody-test-bundles'),
		S3_BUCKET_BLOBS: mockValue('S3_BUCKET_BLOBS', 'kody-test-blobs'),
		KMS_KEY_ID: mockValue('KMS_KEY_ID', 'alias/kody-test'),
		TEMPORAL_ADDRESS: mockValue('TEMPORAL_ADDRESS', 'localhost:7233'),
		TEMPORAL_NAMESPACE_CORE: mockValue('TEMPORAL_NAMESPACE_CORE', 'kody-core'),
		TEMPORAL_NAMESPACE_EXEC: mockValue('TEMPORAL_NAMESPACE_EXEC', 'kody-exec'),
		TEMPORAL_NAMESPACE_OPS: mockValue('TEMPORAL_NAMESPACE_OPS', 'kody-ops'),
		AGENTCORE_RUNNER_ARN: mockValue(
			'AGENTCORE_RUNNER_ARN',
			'arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/kody_runner_test',
		),
		AGENTCORE_MCP_ARN: mockValue(
			'AGENTCORE_MCP_ARN',
			'arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/kody_mcp_test',
		),
		AGENTCORE_CODE_INTERPRETER_ID: mockValue(
			'AGENTCORE_CODE_INTERPRETER_ID',
			'kody_checks_test',
		),
		AGENTCORE_IDENTITY_WORKLOAD: mockValue(
			'AGENTCORE_IDENTITY_WORKLOAD',
			'kody-egress-test',
		),
		RUN_TOKEN_SIGNING_KEY: mockValue(
			'RUN_TOKEN_SIGNING_KEY',
			'mock-run-token-signing-key-000000000000',
		),
		BEDROCK_EMBEDDING_MODEL_ID: mockValue(
			'BEDROCK_EMBEDDING_MODEL_ID',
			'amazon.titan-embed-text-v2:0',
		),
		SES_FROM_DOMAIN: mockValue('SES_FROM_DOMAIN', 'inbox.kody.test'),
		APP_DB: database.db,
		APP_DB_READER: database.reader,
		AUDIT_DB: audit.db,
		AUDIT_DB_READER: audit.reader,
		SEARCH_INDEX: createPgSearchIndex({
			db: database.db,
			reader: database.reader,
			userId: options.userId ?? '__kody_builtin__',
		}),
		BEDROCK_EMBEDDINGS: {
			async embedTexts(texts: readonly string[]) {
				return texts.map((text) => deterministicEmbedding(text, 1024))
			},
		},
		db: database.db,
		reader: database.reader,
		pg: database.pg,
		kv: createFakeKvTable(options),
		objects: createFakeObjectStore(options),
		kms: createFakeKms(),
		vault: createFakeTokenVault([
			mockValue('AGENTCORE_IDENTITY_WORKLOAD', 'kody-egress-test'),
		]),
		runner: createFakeRunner(),
		interpreter: createFakeCodeInterpreter(),
		ses: createFakeSes(),
		TEMPORAL: {
			idempotency: createDynamoIdempotency({
				region: 'us-east-1',
				idempotencyTable: 'target-idempotency',
				send: createFakeDynamo().send,
			}),
			results: createTestObjectBucket().bucket,
			client: async (taskQueue) =>
				(await startTemporal()).temporal.client(taskQueue),
		} satisfies KodyTemporal,
	}
	// Started on first use: a dev server plus the four Kody workers running
	// the target activities over this env's fakes.
	let temporal: Promise<TemporalTestEnv> | undefined
	function startTemporal() {
		return (temporal ??= (async () => {
			const started = await createTemporalEnv({
				kms: env.kms,
				idempotency: env.TEMPORAL.idempotency,
				results: env.TEMPORAL.results,
			})
			await started.startWorkers({ activities: createTargetActivities(env) })
			return started
		})())
	}
	return {
		env: env satisfies AwsEnv,
		createTemporalEnv,
		close: async () => {
			await Promise.all([
				database[Symbol.asyncDispose](),
				audit[Symbol.asyncDispose](),
				temporal?.then((started) => started.close()),
			])
		},
	}
}
