import { createDynamoRunRecords } from '#worker/aws/dynamo-runs.ts'
import { type RunLogRowInput } from '#worker/run-records/run-log-types.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import { createTestObjectBucket } from './aws/fake-s3.ts'

const runsTable = 'kody-test-runs'

/**
 * Run records for node tests: the production DynamoDB adapter over the
 * in-memory DynamoDB and S3 fakes. `env` carries the `RUN_RECORDS` binding;
 * `dynamo`/`logs` expose the raw table and log objects for assertions.
 */
export function createTestRunRecords(
	options: { now?: () => number; retentionEveryNFinishes?: number } = {},
) {
	const dynamo = createFakeDynamo()
	const logs = createTestObjectBucket('kody-test-run-logs')
	const open = (overrides: typeof options = {}) =>
		createDynamoRunRecords({
			region: 'us-east-1',
			tableName: runsTable,
			logs: logs.bucket,
			send: dynamo.send,
			...options,
			...overrides,
		})
	const records = open()
	return {
		/** Another store over the same tables (e.g. with different retention cadence). */
		reopen: open,
		env: { RUN_RECORDS: records },
		records,
		forUser: records.forUser,
		dynamo,
		logs,
		tableName: runsTable,
	}
}

/**
 * A complete run row (defaults: a running `execute` run started a minute
 * ago, inside the 30-day history window).
 */
export function createRunRow(
	overrides: Partial<RunLogRowInput> & { id: string },
): RunLogRowInput {
	const startedAt =
		overrides.startedAt ?? new Date(Date.now() - 60_000).toISOString()
	return {
		surface: 'execute',
		status: 'running',
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		finishedAt: null,
		durationMs: null,
		errorName: null,
		errorMessage: null,
		metadataJson: '{}',
		createdAt: startedAt,
		updatedAt: overrides.finishedAt ?? startedAt,
		...overrides,
		startedAt,
	}
}

/** One `RunLogEntryInput` per message, in order. */
export const logLines = (...messages: Array<string>) =>
	messages.map((message, sequence) => ({
		sequence,
		level: 'log' as const,
		message,
		fieldsJson: null,
	}))
