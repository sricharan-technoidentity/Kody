import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	TransactWriteItemsCommand,
	UpdateItemCommand,
	type AttributeValue,
	type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import {
	type ActivationMilestone,
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
	countsTowardPackageActivation,
} from '#worker/run-records/package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityStatus,
	type JobRunObservabilityUpsertInput,
} from '#worker/run-records/job-run-observability.ts'
import {
	type ListRunsInput,
	type RunLogEntryInput,
	type RunLogObjects,
	type RunLogRowInput,
	type RunRecords,
	type RunRecordsExportPage,
	type RunRecordsRpc,
	clampMetadataJson,
	decodeCursor,
	encodeCursor,
	isRunErrorTriage,
	isRunSurface,
	normalizePageSize,
	parseJsonRecord,
	platformInterruptTriageNote,
	platformInterruptTriagedBy,
	truncateUtf8,
} from '#worker/run-records/run-log-types.ts'
import {
	type RunErrorTriage,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunRecordSurfaceSummary,
	type RunStatus,
	type RunSurface,
	runErrorTriageForPlatformInterrupt,
	runErrorTriageMaxNoteLength,
	runRecordDefaultPageSize,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxPageSize,
	runRecordMaxRunsPerUser,
	runRecordMaxTextBytes,
	runRecordPlatformInterruptedErrorMessage,
	runRecordPlatformInterruptedErrorName,
	runRecordRetentionDays,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMsForSurface,
} from '#worker/run-records/types.ts'
import {
	conditionalCheckFailedItem,
	type DynamoSend,
	dynamoSend,
	epochSeconds,
	transactionCancellationCodes,
} from './dynamo.ts'

/** The documented replay contract for idempotent surfaces. */
export const runRetentionSeconds = 90 * 24 * 60 * 60

/** Sparse GSI over run items (hash `pk`, range `startedSk`): newest-first history. */
export const runsByStartedIndex = 'runs-by-started'

type Item = Record<string, AttributeValue>

export type IdempotencyRecord = {
	runId: string
	status: 'running' | 'completed'
	claimedAt: string
	/** Pointer to the stored terminal response (S3 key or small JSON). */
	result?: string
}

function sortPart(label: string, value: string) {
	if (!value || value.includes('#')) {
		throw new Error(`Invalid ${label} ${JSON.stringify(value)}.`)
	}
	return value
}

const idempotencyRecord = (item: Item): IdempotencyRecord => ({
	runId: item.runId!.S!,
	status: item.status!.S as IdempotencyRecord['status'],
	claimedAt: item.claimedAt!.S!,
	...(item.result?.S === undefined ? {} : { result: item.result.S }),
})

/**
 * The `idempotency` table (partition `userId`, sort `surface#key`) keeps the
 * 90-day replay promise independent of Temporal retention (P5 workflow
 * starts). Items expire through DynamoDB TTL on `expiresAt`.
 */
export function createDynamoIdempotency(options: {
	region: string
	idempotencyTable: string
	send?: DynamoSend
	now?: () => number
}) {
	const send = dynamoSend(options)
	const now = options.now ?? Date.now
	const idempotencyKey = (input: {
		userId: string
		surface: string
		key: string
	}) => ({
		pk: { S: input.userId },
		sk: { S: `${sortPart('surface', input.surface)}#${input.key}` },
	})
	const expiresAt = (fromMs: number) => ({
		N: String(epochSeconds(fromMs) + runRetentionSeconds),
	})

	return {
		/** Confirm Start without dropping the claim on an uncertain RPC response. */
		async markIdempotencyKeyStarted(input: {
			userId: string
			surface: string
			key: string
			runId: string
		}) {
			await send(
				new UpdateItemCommand({
					TableName: options.idempotencyTable,
					Key: idempotencyKey(input),
					UpdateExpression: 'SET #result = :result',
					ConditionExpression: '#runId = :runId AND #status = :running',
					ExpressionAttributeNames: {
						'#runId': 'runId',
						'#status': 'status',
						'#result': 'result',
					},
					ExpressionAttributeValues: {
						':runId': { S: input.runId },
						':running': { S: 'running' },
						':result': { S: `temporal:${input.runId}` },
					},
				}),
			)
		},
		/** First caller for `surface#key` wins; later callers get the existing claim. */
		async claimIdempotencyKey(input: {
			userId: string
			surface: string
			key: string
			runId: string
		}): Promise<
			{ claimed: true } | { claimed: false; existing: IdempotencyRecord }
		> {
			const at = now()
			try {
				await send(
					new PutItemCommand({
						TableName: options.idempotencyTable,
						Item: {
							...idempotencyKey(input),
							runId: { S: input.runId },
							status: { S: 'running' },
							claimedAt: { S: new Date(at).toISOString() },
							expiresAt: expiresAt(at),
						},
						ConditionExpression:
							'attribute_not_exists(pk) OR #expiresAt <= :now',
						ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
						ExpressionAttributeValues: {
							':now': { N: String(epochSeconds(at)) },
						},
						ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
					}),
				)
				return { claimed: true }
			} catch (error) {
				const item = conditionalCheckFailedItem(error)
				if (!item) throw error
				return { claimed: false, existing: idempotencyRecord(item) }
			}
		},
		async getIdempotencyKey(input: {
			userId: string
			surface: string
			key: string
		}) {
			const { Item } = await send(
				new GetItemCommand({
					TableName: options.idempotencyTable,
					Key: idempotencyKey(input),
					ConsistentRead: true,
				}),
			)
			if (!Item || Number(Item.expiresAt?.N ?? 0) <= epochSeconds(now())) {
				return null
			}
			return idempotencyRecord(Item)
		},
		/** Record the terminal response pointer; only the claiming run may do so. */
		async completeIdempotencyKey(input: {
			userId: string
			surface: string
			key: string
			runId: string
			result: string
		}) {
			await send(
				new UpdateItemCommand({
					TableName: options.idempotencyTable,
					Key: idempotencyKey(input),
					UpdateExpression: 'SET #status = :completed, #result = :result',
					ConditionExpression: '#runId = :runId',
					ExpressionAttributeNames: {
						'#status': 'status',
						'#result': 'result',
						'#runId': 'runId',
					},
					ExpressionAttributeValues: {
						':completed': { S: 'completed' },
						':result': { S: input.result },
						':runId': { S: input.runId },
					},
				}),
			)
		},
		/** Drop a still-running claim so the caller can retry (work never started). */
		async releaseIdempotencyKey(input: {
			userId: string
			surface: string
			key: string
			runId: string
		}) {
			try {
				await send(
					new DeleteItemCommand({
						TableName: options.idempotencyTable,
						Key: idempotencyKey(input),
						ConditionExpression: '#runId = :runId AND #status = :running',
						ExpressionAttributeNames: {
							'#runId': 'runId',
							'#status': 'status',
						},
						ExpressionAttributeValues: {
							':runId': { S: input.runId },
							':running': { S: 'running' },
						},
					}),
				)
				return { released: true }
			} catch (error) {
				conditionalCheckFailedItem(error)
				return { released: false }
			}
		},
	}
}

// ---------------------------------------------------------------------------
// Run records (former RunLog Durable Object: history, logs, keyed claims,
// triage, job observability and package activation).
// ---------------------------------------------------------------------------

const historySeconds = runRecordRetentionDays * 24 * 60 * 60
const maxRetentionDeletesPerPass = 100
const maxStaleReconcilesPerPass = 100
const maxWriteAttempts = 4
const queryPageSize = 100
const autoResolveTriageNote = 'auto-resolved: later success of the same job'
const autoResolveTriagedBy = 'system:auto-resolve'

/** Sort keys inside one user's partition of the `runs` table. */
const sk = {
	run: (runId: string) => `run#${runId}`,
	claim: (surface: string, key: string) => `claim#${surface}#${key}`,
	job: (jobId: string) => `job#${jobId}`,
	pkg: (packageId: string) => `pkg#${packageId}`,
	milestone: (milestone: ActivationMilestone) => `milestone#${milestone}`,
	meta: 'meta',
}

/** S3 key of one run's log lines (a JSON array of `RunRecordLog`). */
export const runLogObjectKey = (userId: string, runId: string) =>
	`run-logs/${userId}/${runId}.json`

const S = (value: string | null | undefined): AttributeValue | undefined =>
	value == null ? undefined : { S: value }
const N = (value: number | null | undefined): AttributeValue | undefined =>
	value == null || !Number.isFinite(value) ? undefined : { N: String(value) }
const str = (item: Item | null | undefined, name: string) =>
	item?.[name]?.S ?? null
const num = (item: Item | null | undefined, name: string) =>
	item?.[name]?.N === undefined ? null : Number(item[name].N)
const compact = (fields: Record<string, AttributeValue | undefined>): Item =>
	Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Item

type StoredRun = RunLogRowInput & {
	logCount: number
	errorTriage: RunErrorTriage | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
}

function runOf(item: Item): RunRecord {
	const surface = str(item, 'surface') ?? ''
	const triage = str(item, 'errorTriage')
	return {
		id: str(item, 'id')!,
		surface: (isRunSurface(surface) ? surface : 'execute') as RunSurface,
		status: str(item, 'status') as RunStatus,
		name: str(item, 'name'),
		packageId: str(item, 'packageId'),
		kodyId: str(item, 'kodyId'),
		sourceId: str(item, 'sourceId'),
		publishedCommit: str(item, 'publishedCommit'),
		storageId: str(item, 'storageId'),
		jobId: str(item, 'jobId'),
		workflowId: str(item, 'workflowId'),
		invocationId: str(item, 'invocationId'),
		sessionId: str(item, 'sessionId'),
		idempotencyKey: str(item, 'idempotencyKey'),
		parentRunId: str(item, 'parentRunId'),
		startedAt: str(item, 'startedAt')!,
		finishedAt: str(item, 'finishedAt'),
		durationMs: num(item, 'durationMs'),
		errorName: str(item, 'errorName'),
		errorMessage: str(item, 'errorMessage'),
		errorTriage: triage && isRunErrorTriage(triage) ? triage : null,
		triageNote: str(item, 'triageNote'),
		triagedAt: str(item, 'triagedAt'),
		triagedBy: str(item, 'triagedBy'),
		metadata: parseJsonRecord(str(item, 'metadataJson')),
		logCount: num(item, 'logCount') ?? 0,
	}
}

function jobOf(item: Item): JobRunObservabilityRecord {
	const status = str(item, 'lastRunStatus')
	return {
		jobId: str(item, 'jobId')!,
		lastRunAt: str(item, 'lastRunAt'),
		lastRunStatus:
			status === 'success' || status === 'error'
				? (status as JobRunObservabilityStatus)
				: null,
		lastRunError: str(item, 'lastRunError'),
		lastDurationMs: num(item, 'lastDurationMs'),
		runCount: num(item, 'runCount') ?? 0,
		successCount: num(item, 'successCount') ?? 0,
		errorCount: num(item, 'errorCount') ?? 0,
		updatedAt: str(item, 'updatedAt')!,
	}
}

const packageSuccessOf = (item: Item): PackageRunSuccessRecord => ({
	packageId: str(item, 'packageId')!,
	successCount: num(item, 'successCount') ?? 0,
	updatedAt: str(item, 'updatedAt')!,
})

const milestoneOf = (item: Item): ActivationMilestoneRecord => ({
	milestone: str(item, 'milestone') as ActivationMilestone,
	reachedAt: str(item, 'reachedAt')!,
	packageId: str(item, 'packageId'),
})

const byStartedDesc = (a: Item, b: Item) =>
	(str(b, 'startedAt') ?? '').localeCompare(str(a, 'startedAt') ?? '') ||
	(str(b, 'id') ?? '').localeCompare(str(a, 'id') ?? '')

/** Builds `SET a = :a, … REMOVE b, … ADD c :c` from field maps (`null` removes). */
function updateOf(
	fields: Record<string, AttributeValue | null>,
	add: Record<string, number> = {},
) {
	const names: Record<string, string> = {}
	const values: Record<string, AttributeValue> = {}
	const set: Array<string> = []
	const remove: Array<string> = []
	for (const [field, value] of Object.entries(fields)) {
		names[`#${field}`] = field
		if (value === null) {
			remove.push(`#${field}`)
		} else {
			values[`:${field}`] = value
			set.push(`#${field} = :${field}`)
		}
	}
	const adds = Object.entries(add).map(([field, amount]) => {
		names[`#${field}`] = field
		values[`:${field}`] = { N: String(amount) }
		return `#${field} :${field}`
	})
	return {
		UpdateExpression: [
			set.length ? `SET ${set.join(', ')}` : '',
			remove.length ? `REMOVE ${remove.join(', ')}` : '',
			adds.length ? `ADD ${adds.join(', ')}` : '',
		]
			.filter(Boolean)
			.join(' '),
		ExpressionAttributeNames: names,
		// DynamoDB rejects an empty `ExpressionAttributeValues` map.
		...(Object.keys(values).length
			? { ExpressionAttributeValues: values }
			: {}),
	} as {
		UpdateExpression: string
		ExpressionAttributeNames: Record<string, string>
		ExpressionAttributeValues?: Record<string, AttributeValue>
	}
}

/** Adds a condition and the `#name`/`:value` pairs it needs to an update. */
function withCondition(
	update: ReturnType<typeof updateOf>,
	condition: string,
	names: Record<string, string> = {},
	values: Record<string, AttributeValue> = {},
) {
	const ExpressionAttributeValues = {
		...update.ExpressionAttributeValues,
		...values,
	}
	return {
		UpdateExpression: update.UpdateExpression,
		ConditionExpression: condition,
		ExpressionAttributeNames: { ...update.ExpressionAttributeNames, ...names },
		...(Object.keys(ExpressionAttributeValues).length
			? { ExpressionAttributeValues }
			: {}),
	}
}

function normalizeLogRows(
	runId: string,
	logs: Array<RunLogEntryInput>,
): Array<RunRecordLog> {
	return logs.slice(-runRecordMaxLogEntriesPerRun).map((log, index) => ({
		runId,
		sequence: index,
		level: log.level as RunLogLevel,
		message: truncateUtf8(String(log.message), runRecordMaxTextBytes),
		fields:
			log.fieldsJson == null
				? null
				: parseJsonRecord(clampMetadataJson(String(log.fieldsJson))),
	}))
}

/**
 * Run history on the DynamoDB `runs` table, one partition per user (the
 * former per-user RunLog Durable Object). Items: `run#<id>` (indexed by
 * `startedSk` in {@link runsByStartedIndex}), `claim#<surface>#<key>`
 * pointers to the run that owns an idempotency key, `job#<jobId>` observability counters, `pkg#<id>` and
 * `milestone#<name>` activation state, and a `meta` finish counter. Log
 * lines live in S3 under {@link runLogObjectKey}.
 *
 * Retention: run items expire 30 days after `startedAt` through DynamoDB TTL
 * (readers hide expired items, as TTL is lazy); the 2,000-run cap is
 * enforced every `runRecordRetentionEveryNFinishes` finishes. Stale
 * `running` rows heal when read and during the cap pass. A terminal write
 * and its job/activation counters commit in one transaction.
 */
// ponytail: cap, summarize, bulk-filter, auto-resolve and storage-id reads query the whole user partition (≤ ~2k runs); add ProjectionExpression or sparse GSIs if read units matter, and a Temporal schedule for stale rows nobody reads (the DO alarm's job).
export function createDynamoRunRecords(options: {
	region: string
	tableName: string
	logs: RunLogObjects
	send?: DynamoSend
	now?: () => number
	retentionEveryNFinishes?: number
}): RunRecords {
	const send = dynamoSend(options)
	const now = options.now ?? Date.now
	const TableName = options.tableName
	const retentionEvery =
		options.retentionEveryNFinishes ?? runRecordRetentionEveryNFinishes
	const iso = () => new Date(now()).toISOString()

	function forUser(userId: string): RunRecordsRpc {
		if (!userId) throw new Error('Run records need a user id.')
		const pk = { S: userId }
		const key = (sortKey: string) => ({ pk, sk: { S: sortKey } })
		const live = (item: Item) => {
			const expiresAt = num(item, 'expiresAt')
			return expiresAt == null || expiresAt > epochSeconds(now())
		}

		async function getItem(sortKey: string) {
			const { Item } = await send(
				new GetItemCommand({
					TableName,
					Key: key(sortKey),
					ConsistentRead: true,
				}),
			)
			return Item ?? null
		}

		async function getLiveRun(runId: string) {
			const item = await getItem(sk.run(runId))
			return item && live(item) ? item : null
		}

		/** Pages a query until `want` items pass `accept`, or the range ends. */
		async function queryItems(
			input: Omit<QueryCommand['input'], 'TableName'>,
			accept: (item: Item) => boolean = () => true,
			want = Number.POSITIVE_INFINITY,
		) {
			const items: Array<Item> = []
			let start = input.ExclusiveStartKey
			do {
				const page = await send(
					new QueryCommand({
						...input,
						TableName,
						ExclusiveStartKey: start,
						Limit: queryPageSize,
					}),
				)
				for (const item of page.Items ?? []) {
					if (accept(item)) items.push(item)
					if (items.length >= want) return items
				}
				start = page.LastEvaluatedKey
			} while (start)
			return items
		}

		const prefixQuery = (prefix: string, startAfter?: string) => ({
			KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
			ExpressionAttributeValues: { ':pk': pk, ':prefix': { S: prefix } },
			...(startAfter ? { ExclusiveStartKey: key(startAfter) } : {}),
		})

		const allRuns = () => queryItems(prefixQuery('run#'), live)

		function runItem(run: StoredRun): Item {
			const startedMs = Date.parse(run.startedAt)
			return compact({
				...key(sk.run(run.id)),
				startedSk: { S: `${run.startedAt}#${run.id}` },
				expiresAt: N(
					epochSeconds(Number.isFinite(startedMs) ? startedMs : now()) +
						historySeconds,
				),
				id: S(run.id),
				surface: S(run.surface),
				status: S(run.status),
				name: S(run.name),
				packageId: S(run.packageId),
				kodyId: S(run.kodyId),
				sourceId: S(run.sourceId),
				publishedCommit: S(run.publishedCommit),
				storageId: S(run.storageId),
				jobId: S(run.jobId),
				workflowId: S(run.workflowId),
				invocationId: S(run.invocationId),
				sessionId: S(run.sessionId),
				idempotencyKey: S(run.idempotencyKey),
				parentRunId: S(run.parentRunId),
				startedAt: S(run.startedAt),
				finishedAt: S(run.finishedAt),
				durationMs: N(run.durationMs),
				errorName: S(run.errorName),
				errorMessage: S(run.errorMessage),
				metadataJson: S(clampMetadataJson(run.metadataJson || '{}')),
				createdAt: S(run.createdAt),
				updatedAt: S(run.updatedAt),
				logCount: N(run.logCount),
				errorTriage: S(run.errorTriage),
				triageNote: S(run.triageNote),
				triagedAt: S(run.triagedAt),
				triagedBy: S(run.triagedBy),
			})
		}

		const openRun = (run: RunLogRowInput, logCount: number): StoredRun => ({
			...run,
			logCount,
			errorTriage: null,
			triageNote: null,
			triagedAt: null,
			triagedBy: null,
		})

		async function writeLogs(runId: string, logs: Array<RunRecordLog>) {
			await options.logs.put(
				runLogObjectKey(userId, runId),
				JSON.stringify(logs),
				{ httpMetadata: { contentType: 'application/json' } },
			)
		}

		async function readLogs(item: Item): Promise<Array<RunRecordLog>> {
			if (!num(item, 'logCount')) return []
			const object = await options.logs.get(
				runLogObjectKey(userId, str(item, 'id')!),
			)
			return object
				? (JSON.parse(await object.text()) as Array<RunRecordLog>)
				: []
		}

		async function deleteRuns(items: Array<Item>) {
			for (const item of items) {
				try {
					await send(
						new DeleteItemCommand({
							TableName,
							Key: key(str(item, 'sk')!),
							ConditionExpression: '#status = :status',
							ExpressionAttributeNames: { '#status': 'status' },
							ExpressionAttributeValues: { ':status': item.status! },
						}),
					)
				} catch (error) {
					conditionalCheckFailedItem(error)
					continue
				}
				if (num(item, 'logCount')) {
					await options.logs.delete(runLogObjectKey(userId, str(item, 'id')!))
				}
			}
		}

		function isStaleRunning(item: Item) {
			if (str(item, 'status') !== 'running') return false
			const surface = str(item, 'surface') ?? ''
			const startedMs = Date.parse(str(item, 'startedAt') ?? '')
			if (!Number.isFinite(startedMs)) return false
			return (
				now() - startedMs >=
				runRecordStaleRunningTtlMsForSurface(
					isRunSurface(surface) ? surface : 'execute',
				)
			)
		}

		/**
		 * Mark a stranded `running` row `error` + `platform_interrupted` once it
		 * is past its surface TTL. Retryable unattended deliveries are retained
		 * as ignored history; everything else stays open.
		 */
		async function heal(item: Item): Promise<Item> {
			if (!isStaleRunning(item)) return item
			const finishedAt = iso()
			const startedMs = Date.parse(str(item, 'startedAt')!)
			const surface = str(item, 'surface') ?? ''
			const triage = runErrorTriageForPlatformInterrupt({
				surface: isRunSurface(surface) ? surface : 'execute',
				idempotencyKey: str(item, 'idempotencyKey'),
			})
			try {
				const { Attributes } = await send(
					new UpdateItemCommand({
						TableName,
						Key: key(str(item, 'sk')!),
						...withCondition(
							updateOf({
								status: { S: 'error' },
								finishedAt: { S: finishedAt },
								durationMs: {
									N: String(Math.max(0, Date.parse(finishedAt) - startedMs)),
								},
								errorName: { S: runRecordPlatformInterruptedErrorName },
								errorMessage: { S: runRecordPlatformInterruptedErrorMessage },
								errorTriage: triage ? { S: triage } : null,
								triageNote: triage ? { S: platformInterruptTriageNote } : null,
								triagedAt: triage ? { S: finishedAt } : null,
								triagedBy: triage ? { S: platformInterruptTriagedBy } : null,
								updatedAt: { S: finishedAt },
							}),
							'#status = :running',
							{},
							{ ':running': { S: 'running' } },
						),
						ReturnValues: 'ALL_NEW',
					}),
				)
				return Attributes ?? item
			} catch (error) {
				conditionalCheckFailedItem(error)
				return (await getItem(str(item, 'sk')!)) ?? item
			}
		}

		const healedRun = async (item: Item) => runOf(await heal(item))

		/** Insert a `running` row unless it already exists (INSERT OR IGNORE). */
		async function insertRunningRun(
			run: RunLogRowInput,
			initialLogs: Array<RunLogEntryInput> = [],
		) {
			const logs = normalizeLogRows(run.id, initialLogs)
			try {
				await send(
					new PutItemCommand({
						TableName,
						Item: runItem(openRun(run, logs.length)),
						ConditionExpression: 'attribute_not_exists(pk)',
					}),
				)
			} catch (error) {
				conditionalCheckFailedItem(error)
				return
			}
			if (logs.length) await writeLogs(run.id, logs)
			await indexIdempotencyKey(run)
		}

		async function findClaimOwner(surface: string, idempotencyKey: string) {
			const claim = await getItem(sk.claim(surface, idempotencyKey))
			const owner = claim ? await getLiveRun(str(claim, 'runId')!) : null
			return { claim, owner }
		}

		/**
		 * Point `claim#<surface>#<key>` at the run that owns the key: an
		 * in-flight run first, then the newest terminal one (the DO's lookup
		 * order). `claimRun` sets it atomically; other keyed writes (workflow,
		 * package and delivery runs) keep it current best-effort.
		 */
		async function indexIdempotencyKey(run: RunLogRowInput) {
			const idempotencyKey = run.idempotencyKey?.trim()
			if (!idempotencyKey) return
			const { claim, owner } = await findClaimOwner(run.surface, idempotencyKey)
			if (str(claim, 'runId') === run.id) return
			if (owner) {
				const ownerRunning = str(owner, 'status') === 'running'
				const running = run.status === 'running'
				if (ownerRunning && !running) return
				if (
					ownerRunning === running &&
					(str(owner, 'startedAt') ?? '') > run.startedAt
				) {
					return
				}
			}
			const startedMs = Date.parse(run.startedAt)
			try {
				await send(
					new PutItemCommand({
						TableName,
						Item: {
							...key(sk.claim(run.surface, idempotencyKey)),
							runId: { S: run.id },
							expiresAt: {
								N: String(
									epochSeconds(Number.isFinite(startedMs) ? startedMs : now()) +
										historySeconds,
								),
							},
						},
						...(claim
							? {
									ConditionExpression: '#runId = :previous',
									ExpressionAttributeNames: { '#runId': 'runId' },
									ExpressionAttributeValues: { ':previous': claim.runId! },
								}
							: { ConditionExpression: 'attribute_not_exists(pk)' }),
					}),
				)
			} catch (error) {
				// A concurrent claim or newer run moved the pointer first.
				conditionalCheckFailedItem(error)
			}
		}

		function jobOutcomeUpdate(input: JobRunObservabilityUpsertInput) {
			const jobId = input.jobId.trim()
			const durationMs =
				typeof input.durationMs === 'number' &&
				Number.isFinite(input.durationMs)
					? Math.max(0, Math.trunc(input.durationMs))
					: null
			const error =
				input.status === 'error' ? input.error?.trim() || null : null
			return {
				TableName,
				Key: key(sk.job(jobId)),
				...updateOf(
					{
						jobId: { S: jobId },
						lastRunAt: { S: input.ranAt },
						lastRunStatus: { S: input.status },
						lastRunError: error == null ? null : { S: error },
						lastDurationMs:
							durationMs == null ? null : { N: String(durationMs) },
						updatedAt: { S: input.ranAt },
					},
					{
						runCount: 1,
						successCount: input.status === 'success' ? 1 : 0,
						errorCount: input.status === 'error' ? 1 : 0,
					},
				),
			}
		}

		/**
		 * Activation and job counters for a genuine new terminal write, as
		 * transaction items guarded by the state they were computed from.
		 * Replays of an already-terminal run count nothing.
		 */
		async function terminalSideEffects(
			previousStatus: string | null,
			run: RunLogRowInput,
		): Promise<Array<TransactWriteItem>> {
			const items: Array<TransactWriteItem> = []
			const reachedAt = run.finishedAt ?? run.updatedAt ?? iso()
			const packageId = run.packageId?.trim()
			if (
				run.status === 'success' &&
				previousStatus !== 'success' &&
				packageId &&
				countsTowardPackageActivation(run.surface)
			) {
				// Global latch: once activated, package counters stop changing.
				const activated = await getItem(sk.milestone('package_activated'))
				if (!activated) {
					const counter = await getItem(sk.pkg(packageId))
					const prior = num(counter, 'successCount') ?? 0
					const milestone = (name: ActivationMilestone) =>
						updateOf({
							milestone: { S: name },
							reachedAt: { S: reachedAt },
							packageId: { S: packageId },
						})
					items.push({
						Update: {
							TableName,
							Key: key(sk.pkg(packageId)),
							...withCondition(
								updateOf({
									packageId: { S: packageId },
									successCount: { N: String(prior + 1) },
									updatedAt: { S: reachedAt },
								}),
								counter ? '#successCount = :prior' : 'attribute_not_exists(pk)',
								{},
								counter ? { ':prior': { N: String(prior) } } : {},
							),
						},
					})
					items.push({
						Update: {
							TableName,
							Key: key(sk.milestone('package_run_succeeded')),
							...milestone('package_run_succeeded'),
							// INSERT OR IGNORE: the first success keeps its timestamp.
							UpdateExpression:
								'SET #milestone = :milestone, #reachedAt = if_not_exists(#reachedAt, :reachedAt), #packageId = if_not_exists(#packageId, :packageId)',
						},
					})
					items.push(
						prior + 1 >= 2
							? {
									Update: {
										TableName,
										Key: key(sk.milestone('package_activated')),
										...withCondition(
											milestone('package_activated'),
											'attribute_not_exists(pk)',
										),
									},
								}
							: {
									ConditionCheck: {
										TableName,
										Key: key(sk.milestone('package_activated')),
										ConditionExpression: 'attribute_not_exists(pk)',
									},
								},
					)
				}
			}
			const jobId = run.jobId?.trim()
			if (
				jobId &&
				(run.status === 'success' || run.status === 'error') &&
				previousStatus !== 'success' &&
				previousStatus !== 'error'
			) {
				items.push({
					Update: jobOutcomeUpdate({
						jobId,
						status: run.status,
						ranAt: reachedAt,
						error:
							run.status === 'error'
								? run.errorMessage?.trim() || run.errorName?.trim() || null
								: null,
						durationMs: run.durationMs,
					}),
				})
			}
			return items
		}

		/**
		 * A later success of the same scheduled job soft-resolves its earlier
		 * open errors. Only `jobId` is a strong enough identity for this.
		 */
		async function autoResolvePriorJobErrors(
			previousStatus: string | null,
			run: RunLogRowInput,
		) {
			const jobId = run.jobId?.trim()
			if (
				run.status !== 'success' ||
				previousStatus === 'success' ||
				run.surface !== 'job' ||
				!jobId
			) {
				return
			}
			const triagedAt = run.finishedAt ?? run.updatedAt ?? iso()
			const open = (await allRuns()).filter(
				(item) =>
					str(item, 'surface') === 'job' &&
					str(item, 'jobId') === jobId &&
					str(item, 'status') === 'error' &&
					!item.errorTriage &&
					str(item, 'id') !== run.id,
			)
			for (const item of open) {
				try {
					await send(
						new UpdateItemCommand({
							TableName,
							Key: key(str(item, 'sk')!),
							...withCondition(
								updateOf({
									errorTriage: { S: 'resolved' },
									triageNote: { S: autoResolveTriageNote },
									triagedAt: { S: triagedAt },
									triagedBy: { S: autoResolveTriagedBy },
									updatedAt: { S: triagedAt },
								}),
								'#status = :error AND attribute_not_exists(#errorTriage)',
								{ '#status': 'status' },
								{ ':error': { S: 'error' } },
							),
						}),
					)
				} catch (error) {
					conditionalCheckFailedItem(error)
				}
			}
		}

		/**
		 * Heal stale `running` rows, then evict over the 2,000-run cap: handled
		 * errors first, then successes, open errors last; in-flight rows never.
		 */
		async function enforceRetention() {
			let runs = await allRuns()
			const stale = runs
				.filter(isStaleRunning)
				.slice(0, maxStaleReconcilesPerPass)
			if (stale.length) {
				const healed = new Map<string, Item>()
				for (const item of stale) healed.set(str(item, 'sk')!, await heal(item))
				runs = runs.map((item) => healed.get(str(item, 'sk')!) ?? item)
			}
			const excess = runs.length - runRecordMaxRunsPerUser
			if (excess <= 0) return
			const oldestFirst = [...runs].sort(byStartedDesc).reverse()
			const pick = (accept: (item: Item) => boolean) =>
				oldestFirst.filter(accept)
			const victims = [
				...pick(
					(item) => str(item, 'status') === 'error' && !!item.errorTriage,
				),
				...pick((item) => str(item, 'status') === 'success'),
				...pick((item) => str(item, 'status') === 'error' && !item.errorTriage),
			].slice(0, Math.min(excess, maxRetentionDeletesPerPass))
			await deleteRuns(victims)
		}

		async function countFinishAndMaybeEnforceRetention() {
			try {
				const { Attributes } = await send(
					new UpdateItemCommand({
						TableName,
						Key: key(sk.meta),
						...updateOf({}, { finishes: 1 }),
						ReturnValues: 'ALL_NEW',
					}),
				)
				if ((num(Attributes, 'finishes') ?? 0) % retentionEvery === 0) {
					await enforceRetention()
				}
			} catch (error) {
				// Retention is housekeeping; the finished run is already stored.
				console.warn('run-retention-failed', error)
			}
		}

		async function phasePage(
			prefix: string,
			startAfterId: string,
			limit: number,
			accept?: (item: Item) => boolean,
		) {
			const items = await queryItems(
				prefixQuery(
					prefix,
					startAfterId ? `${prefix}${startAfterId}` : undefined,
				),
				accept,
				limit + 1,
			)
			const truncated = items.length > limit
			const page = truncated ? items.slice(0, limit) : items
			const last = page.at(-1)
			return {
				items: page,
				truncated,
				nextId: last ? str(last, 'sk')!.slice(prefix.length) : startAfterId,
			}
		}

		return {
			async startRun(input) {
				await insertRunningRun(input.run, input.initialLogs)
				return { ok: true }
			},

			async claimRun(input) {
				const idempotencyKey = input.run.idempotencyKey?.trim() || null
				if (!idempotencyKey) {
					await insertRunningRun(input.run)
					const item = await getItem(sk.run(input.run.id))
					return {
						claimed: true,
						run: runOf(item ?? runItem(openRun(input.run, 0))),
					}
				}
				for (let attempt = 0; attempt < maxWriteAttempts; attempt += 1) {
					const { claim, owner } = await findClaimOwner(
						input.run.surface,
						idempotencyKey,
					)
					// Terminal owners (including healed interrupts) keep the key for replay.
					if (owner) return { claimed: false, run: await healedRun(owner) }
					const item = runItem(openRun(input.run, 0))
					try {
						await send(
							new TransactWriteItemsCommand({
								TransactItems: [
									{
										Put: {
											TableName,
											Item: {
												...key(sk.claim(input.run.surface, idempotencyKey)),
												runId: { S: input.run.id },
												expiresAt: item.expiresAt!,
											},
											// A pointer to a pruned run is free to take over.
											...(claim
												? {
														ConditionExpression: '#runId = :stale',
														ExpressionAttributeNames: { '#runId': 'runId' },
														ExpressionAttributeValues: {
															':stale': claim.runId!,
														},
													}
												: { ConditionExpression: 'attribute_not_exists(pk)' }),
										},
									},
									{
										Put: {
											TableName,
											Item: item,
											ConditionExpression: 'attribute_not_exists(pk)',
										},
									},
								],
							}),
						)
						return { claimed: true, run: runOf(item) }
					} catch (error) {
						transactionCancellationCodes(error)
					}
				}
				throw new Error('Run claim did not converge under contention.')
			},

			async finishRun(input) {
				const run = input.run
				const logs = normalizeLogRows(run.id, input.logs)
				let previousStatus: string | null = null
				let written = false
				for (
					let attempt = 0;
					attempt < maxWriteAttempts && !written;
					attempt += 1
				) {
					const current = await getItem(sk.run(run.id))
					previousStatus = str(current, 'status')
					if (attempt === 0) {
						if (logs.length) await writeLogs(run.id, logs)
						else if (num(current, 'logCount')) {
							await options.logs.delete(runLogObjectKey(userId, run.id))
						}
					}
					// Error finishes keep user triage, but not the system's own
					// platform-interrupt auto-ignore of the row being replaced.
					const keepTriage =
						run.status === 'error' &&
						current != null &&
						!(
							str(current, 'errorName') ===
								runRecordPlatformInterruptedErrorName &&
							str(current, 'triagedBy') === platformInterruptTriagedBy
						)
					const triage = str(current, 'errorTriage')
					const stored: StoredRun = {
						...run,
						logCount: logs.length,
						errorTriage:
							keepTriage && triage && isRunErrorTriage(triage) ? triage : null,
						triageNote: keepTriage ? str(current, 'triageNote') : null,
						triagedAt: keepTriage ? str(current, 'triagedAt') : null,
						triagedBy: keepTriage ? str(current, 'triagedBy') : null,
					}
					const sideEffects = await terminalSideEffects(previousStatus, run)
					try {
						await send(
							new TransactWriteItemsCommand({
								TransactItems: [
									{
										Put: {
											TableName,
											Item: runItem(stored),
											...(current
												? {
														ConditionExpression: '#updatedAt = :updatedAt',
														ExpressionAttributeNames: {
															'#updatedAt': 'updatedAt',
														},
														ExpressionAttributeValues: {
															':updatedAt': current.updatedAt!,
														},
													}
												: { ConditionExpression: 'attribute_not_exists(pk)' }),
										},
									},
									...sideEffects,
								],
							}),
						)
						written = true
					} catch (error) {
						transactionCancellationCodes(error)
					}
				}
				if (!written) {
					throw new Error('Run finish did not converge under contention.')
				}
				await indexIdempotencyKey(run)
				await autoResolvePriorJobErrors(previousStatus, run)
				await countFinishAndMaybeEnforceRetention()
				return { ok: true }
			},

			async listRuns(input: ListRunsInput) {
				const limit = normalizePageSize(input.limit, runRecordDefaultPageSize)
				const filters = ['#expiresAt > :now']
				const names: Record<string, string> = { '#expiresAt': 'expiresAt' }
				const values: Record<string, AttributeValue> = {
					':pk': pk,
					':now': { N: String(epochSeconds(now())) },
				}
				const equals = (field: string, value: string | null | undefined) => {
					if (!value) return
					filters.push(`#${field} = :${field}`)
					names[`#${field}`] = field
					values[`:${field}`] = { S: value }
				}
				equals('surface', input.surface)
				equals('status', input.status)
				equals('packageId', input.packageId)
				equals('jobId', input.jobId)
				equals('name', input.name)
				const errorTriage = input.errorTriage ?? null
				if (errorTriage === 'open') {
					// Hide ignored/resolved noise; successes and running rows stay.
					filters.push('attribute_not_exists(#errorTriage)')
					names['#errorTriage'] = 'errorTriage'
				} else if (errorTriage === 'ignored' || errorTriage === 'resolved') {
					equals('errorTriage', errorTriage)
				}
				if (input.since) values[':since'] = { S: input.since }
				const cursor = input.cursor ? decodeCursor(input.cursor) : null
				const rows = await queryItems(
					{
						IndexName: runsByStartedIndex,
						KeyConditionExpression: input.since
							? 'pk = :pk AND startedSk >= :since'
							: 'pk = :pk',
						FilterExpression: filters.join(' AND '),
						ExpressionAttributeNames: names,
						ExpressionAttributeValues: values,
						ScanIndexForward: false,
						...(cursor
							? {
									ExclusiveStartKey: {
										...key(sk.run(cursor.id)),
										startedSk: { S: `${cursor.startedAt}#${cursor.id}` },
									},
								}
							: {}),
					},
					() => true,
					limit + 1,
				)
				const hasMore = rows.length > limit
				const page = hasMore ? rows.slice(0, limit) : rows
				const runs: Array<RunRecord> = []
				for (const row of page) {
					// Healing can move a row out of the requested status/triage.
					const run = await healedRun(row)
					if (input.status && run.status !== input.status) continue
					if (errorTriage === 'open' && run.errorTriage != null) continue
					runs.push(run)
				}
				const last = page.at(-1)
				return {
					runs,
					nextCursor:
						hasMore && last
							? encodeCursor({
									startedAt: str(last, 'startedAt')!,
									id: str(last, 'id')!,
								})
							: null,
				}
			},

			async getRun(input) {
				const item = await getLiveRun(input.runId)
				if (!item) return null
				const healed = await heal(item)
				return { run: runOf(healed), logs: await readLogs(healed) }
			},

			async getRunByIdempotencyKey(input) {
				const idempotencyKey = input.idempotencyKey.trim()
				if (!idempotencyKey) return null
				if (input.surface) {
					const { owner } = await findClaimOwner(input.surface, idempotencyKey)
					return owner ? await healedRun(owner) : null
				}
				// Unscoped lookup: prefer an in-flight row, then the newest terminal one.
				const matches = (await allRuns())
					.filter((item) => str(item, 'idempotencyKey') === idempotencyKey)
					.sort(
						(a, b) =>
							Number(str(b, 'status') === 'running') -
								Number(str(a, 'status') === 'running') || byStartedDesc(a, b),
					)
				return matches[0] ? await healedRun(matches[0]) : null
			},

			async deleteRunIfRunning(input) {
				let removed: Item | undefined
				try {
					const output = await send(
						new DeleteItemCommand({
							TableName,
							Key: key(sk.run(input.runId)),
							ConditionExpression: '#status = :running',
							ExpressionAttributeNames: { '#status': 'status' },
							ExpressionAttributeValues: { ':running': { S: 'running' } },
							ReturnValues: 'ALL_OLD',
						}),
					)
					removed = (output as { Attributes?: Item }).Attributes
				} catch (error) {
					conditionalCheckFailedItem(error)
					return { deleted: false }
				}
				if (num(removed, 'logCount')) {
					await options.logs.delete(runLogObjectKey(userId, input.runId))
				}
				const idempotencyKey = str(removed, 'idempotencyKey')
				if (idempotencyKey) {
					// Release the claim so a retry after failed setup is not poisoned.
					try {
						await send(
							new DeleteItemCommand({
								TableName,
								Key: key(sk.claim(str(removed, 'surface')!, idempotencyKey)),
								ConditionExpression: '#runId = :runId',
								ExpressionAttributeNames: { '#runId': 'runId' },
								ExpressionAttributeValues: { ':runId': { S: input.runId } },
							}),
						)
					} catch (error) {
						conditionalCheckFailedItem(error)
					}
				}
				return { deleted: true }
			},

			async summarize(input) {
				const rows = await queryItems(
					{
						IndexName: runsByStartedIndex,
						KeyConditionExpression: 'pk = :pk AND startedSk >= :since',
						ExpressionAttributeValues: {
							':pk': pk,
							':since': { S: input.since },
						},
					},
					live,
				)
				const bySurface = new Map<RunSurface, RunRecordSurfaceSummary>()
				const summary = {
					since: input.since,
					total: 0,
					errors: 0,
					ignored: 0,
					resolved: 0,
					running: 0,
				}
				for (const row of rows) {
					const run = runOf(row)
					const openError = run.status === 'error' && run.errorTriage == null
					summary.total += 1
					if (openError) summary.errors += 1
					if (run.errorTriage === 'ignored') summary.ignored += 1
					if (run.errorTriage === 'resolved') summary.resolved += 1
					if (run.status === 'running') summary.running += 1
					const entry = bySurface.get(run.surface) ?? {
						surface: run.surface,
						total: 0,
						errors: 0,
					}
					entry.total += 1
					if (openError) entry.errors += 1
					bySurface.set(run.surface, entry)
				}
				return {
					...summary,
					bySurface: [...bySurface.values()].sort((a, b) =>
						a.surface.localeCompare(b.surface),
					),
				}
			},

			async updateRunErrorTriage(input) {
				const existing = await getLiveRun(input.runId)
				if (!existing) return { ok: false, reason: 'not_found' }
				const current = runOf(existing)
				const nextTriage = input.errorTriage
				if (nextTriage != null && current.status !== 'error') {
					return {
						ok: false,
						reason: 'not_error',
						status: current.status,
						runId: input.runId,
					}
				}
				const at = iso()
				let triageNote: string | null = null
				if (nextTriage != null) {
					if (input.preserveTriageNote) {
						triageNote = current.triageNote
					} else if (input.triageNote != null) {
						triageNote =
							input.triageNote.trim().slice(0, runErrorTriageMaxNoteLength) ||
							null
					}
				}
				const triagedBy =
					nextTriage == null ? null : input.triagedBy.trim() || null
				try {
					const { Attributes } = await send(
						new UpdateItemCommand({
							TableName,
							Key: key(sk.run(input.runId)),
							...withCondition(
								updateOf({
									errorTriage: nextTriage == null ? null : { S: nextTriage },
									triageNote: triageNote == null ? null : { S: triageNote },
									triagedAt: nextTriage == null ? null : { S: at },
									triagedBy: triagedBy == null ? null : { S: triagedBy },
									updatedAt: { S: at },
								}),
								'attribute_exists(pk)',
							),
							ReturnValues: 'ALL_NEW',
						}),
					)
					return { ok: true, run: runOf(Attributes!) }
				} catch (error) {
					conditionalCheckFailedItem(error)
					return { ok: false, reason: 'not_found' }
				}
			},

			async bulkUpdateRunErrorTriage(input) {
				const limit = normalizePageSize(input.limit, runRecordMaxPageSize)
				const runIds = (input.runIds ?? [])
					.map((id) => id.trim())
					.filter(Boolean)
					.slice(0, runRecordMaxPageSize)
				const filter = runIds.length > 0 ? null : input.filter
				if (runIds.length === 0 && !filter) {
					return { matchedRunIds: [], updatedCount: 0, hasMore: false }
				}
				const candidates =
					runIds.length > 0
						? (await Promise.all(runIds.map(getLiveRun))).filter(
								(item): item is Item => item != null,
							)
						: await allRuns()
				const filterTriage = filter
					? (filter.errorTriage ??
						(input.errorTriage == null ? null : ('open' as const)))
					: null
				const matches = candidates
					.map((item) => ({ item, run: runOf(item) }))
					.filter(({ run }) => {
						if (run.status !== 'error') return false
						// Reopening already-open rows is a no-op, not a match.
						if (input.errorTriage == null && run.errorTriage == null) {
							return false
						}
						if (filter) {
							if (filter.surface && run.surface !== filter.surface) return false
							if (filter.packageId && run.packageId !== filter.packageId) {
								return false
							}
							if (filter.jobId && run.jobId !== filter.jobId) return false
							if (filter.name && run.name !== filter.name) return false
							if (filter.errorName && run.errorName !== filter.errorName) {
								return false
							}
							if (
								filter.errorMessage &&
								run.errorMessage !== filter.errorMessage
							) {
								return false
							}
						}
						if (filterTriage === 'open') return run.errorTriage == null
						if (filterTriage === 'ignored' || filterTriage === 'resolved') {
							return run.errorTriage === filterTriage
						}
						return true
					})
					.sort((a, b) => byStartedDesc(a.item, b.item))
				const hasMore = matches.length > limit
				const matched = matches.slice(0, limit)
				const matchedRunIds = matched.map(({ run }) => run.id)
				if (input.dryRun || matched.length === 0) {
					return { matchedRunIds, updatedCount: 0, hasMore }
				}
				const at = iso()
				const note =
					input.triageNote == null
						? null
						: input.triageNote.trim().slice(0, runErrorTriageMaxNoteLength) ||
							null
				const triagedBy = input.triagedBy.trim() || null
				const fields: Record<string, AttributeValue | null> =
					input.errorTriage == null
						? {
								errorTriage: null,
								triageNote: null,
								triagedAt: null,
								triagedBy: null,
								updatedAt: { S: at },
							}
						: {
								errorTriage: { S: input.errorTriage },
								...(input.preserveTriageNote
									? {}
									: { triageNote: note == null ? null : { S: note } }),
								triagedAt: { S: at },
								triagedBy: triagedBy == null ? null : { S: triagedBy },
								updatedAt: { S: at },
							}
				// One transaction (≤ 100 items, the public limit) so a failure
				// leaves every selected row unchanged.
				await send(
					new TransactWriteItemsCommand({
						TransactItems: matched.map(({ item }) => ({
							Update: {
								TableName,
								Key: key(str(item, 'sk')!),
								...withCondition(
									updateOf(fields),
									'#status = :error',
									{ '#status': 'status' },
									{ ':error': { S: 'error' } },
								),
							},
						})),
					}),
				)
				return { matchedRunIds, updatedCount: matched.length, hasMore }
			},

			async listStorageIds() {
				const ids = new Set<string>()
				for (const item of await allRuns()) {
					const storageId = str(item, 'storageId')
					if (storageId) ids.add(storageId)
				}
				return [...ids].sort()
			},

			async upsertJobRunObservability(input) {
				const { Attributes } = await send(
					new UpdateItemCommand({
						...jobOutcomeUpdate(input),
						ReturnValues: 'ALL_NEW',
					}),
				)
				return jobOf(Attributes!)
			},

			async getJobRunObservability(input) {
				const item = await getItem(sk.job(input.jobId))
				return item ? jobOf(item) : null
			},

			async getJobRunObservabilityBatch(input) {
				const ids = [
					...new Set(input.jobIds.map((id) => id.trim()).filter(Boolean)),
				].sort()
				const items = await Promise.all(ids.map((id) => getItem(sk.job(id))))
				return items.filter((item): item is Item => item != null).map(jobOf)
			},

			async listPackageRunSuccesses() {
				return (await queryItems(prefixQuery('pkg#'))).map(packageSuccessOf)
			},

			async listActivationMilestones() {
				return (await queryItems(prefixQuery('milestone#'))).map(milestoneOf)
			},

			async getAdminInsightsSnapshot() {
				const jobs = (await queryItems(prefixQuery('job#'))).map(jobOf)
				const milestones = (await queryItems(prefixQuery('milestone#'))).map(
					milestoneOf,
				)
				return {
					workflowStatusCounts: [],
					activationMilestones: milestones,
					jobRunCounts: {
						success: jobs.reduce((sum, job) => sum + job.successCount, 0),
						error: jobs.reduce((sum, job) => sum + job.errorCount, 0),
					},
				}
			},

			/**
			 * Paged export in fixed phases: runs (raw run-id cursors), then
			 * `job-run-observability:`, `package-run-successes:` and
			 * `activation-milestones:`. Each phase fills the rest of the page.
			 */
			async exportRuns(input) {
				const pageSize = normalizePageSize(
					input.pageSize,
					runRecordDefaultPageSize,
				)
				const phases = [
					{ prefix: 'run#', cursor: '' },
					{ prefix: 'job#', cursor: 'job-run-observability:' },
					{ prefix: 'pkg#', cursor: 'package-run-successes:' },
					{ prefix: 'milestone#', cursor: 'activation-milestones:' },
				] as const
				const result: RunRecordsExportPage = {
					runs: [],
					logs: [],
					jobRunObservability: [],
					packageRunSuccesses: [],
					activationMilestones: [],
					nextStartAfter: null,
					truncated: false,
				}
				const startAfter = input.startAfter?.trim() || ''
				let index = phases.findIndex(
					(phase) => phase.cursor !== '' && startAfter.startsWith(phase.cursor),
				)
				let startAfterId = startAfter
				if (index < 0) index = 0
				else startAfterId = startAfter.slice(phases[index]!.cursor.length)
				let remaining = pageSize
				for (; index < phases.length; index += 1) {
					const phase = phases[index]!
					const page = await phasePage(
						phase.prefix,
						startAfterId,
						remaining,
						phase.prefix === 'run#' ? live : undefined,
					)
					switch (phase.prefix) {
						case 'run#':
							for (const item of page.items) {
								result.runs.push(runOf(item))
								result.logs.push(...(await readLogs(item)))
							}
							break
						case 'job#':
							result.jobRunObservability.push(...page.items.map(jobOf))
							break
						case 'pkg#':
							result.packageRunSuccesses.push(
								...page.items.map(packageSuccessOf),
							)
							break
						case 'milestone#':
							result.activationMilestones.push(...page.items.map(milestoneOf))
							break
					}
					remaining -= page.items.length
					if (page.truncated) {
						return {
							...result,
							nextStartAfter: `${phase.cursor}${page.nextId}`,
							truncated: true,
						}
					}
					startAfterId = ''
					const next = phases[index + 1]
					if (remaining <= 0 && next) {
						return { ...result, nextStartAfter: next.cursor, truncated: true }
					}
				}
				return result
			},

			async clearAll() {
				const items = await queryItems({
					KeyConditionExpression: 'pk = :pk',
					ExpressionAttributeValues: { ':pk': pk },
				})
				const logKeys = items
					.filter(
						(item) =>
							str(item, 'sk')!.startsWith('run#') && num(item, 'logCount'),
					)
					.map((item) => runLogObjectKey(userId, str(item, 'id')!))
				if (logKeys.length) await options.logs.delete(logKeys)
				for (const item of items) {
					await send(
						new DeleteItemCommand({ TableName, Key: key(str(item, 'sk')!) }),
					)
				}
				return { ok: true }
			},
		}
	}

	return { forUser }
}
