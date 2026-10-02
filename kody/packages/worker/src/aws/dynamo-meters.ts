import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	TransactWriteItemsCommand,
	UpdateItemCommand,
	type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	conditionalCheckFailedItem,
	type DynamoSend,
	dynamoSend,
	epochSeconds,
	transactionCancellationCodes,
} from './dynamo.ts'
import {
	dailyEntitlementResources,
	isDailyEntitlementResource,
	type DailyEntitlementResource,
	type UserMeterCounterRow,
	type UserMeterReadyState,
	type UserMeterRpc,
	type UserMeterStorageBytesReadyState,
	type UserMeterWriteLeaseEntry,
	userMeterDailyCounterRetentionDays,
	userMeterMirrorUpdatedAtToken,
	type UserMeters,
} from '#worker/entitlements/user-meter-client.ts'

type Item = Record<string, AttributeValue>

const maxCasAttempts = 8
/** TTL garbage-collects day rows a day after they leave the retention window. */
const dayTtlSeconds = (userMeterDailyCounterRetentionDays + 1) * 24 * 60 * 60
const defaultPageSize = 100
const maxPageSize = 500
const inboundMcpConnectionLastUsedMinIntervalMs = 5 * 60 * 1000
const inboundReceiveResource = 'email_receives_per_day' as const
const dayPattern = /^\d{4}-\d{2}-\d{2}$/

/** Sort keys inside one user's partition; counters keep the `counter#day` contract. */
const sk = {
	counter: (resource: string, day: string) => `${resource}#${day}`,
	storage: 'storage_bytes',
	deletion: 'deletion',
	lease: (token: string) => `lease#${token}`,
	delivery: (deliveryId: string) => `inbound_delivery#${deliveryId}`,
	dynamicWorker: (day: string, workerId: string) =>
		`dynamic_worker#${day}#${workerId}`,
	lastUsed: (clientId: string) => `mcp_last_used#${clientId}`,
}

function bounded(label: string, value: string, max: number) {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new Error(
			`UserMeter ${label} must be a non-empty string up to ${max} characters.`,
		)
	}
	return value
}

function dailyResource(resource: string): DailyEntitlementResource {
	if (!isDailyEntitlementResource(resource)) {
		throw new Error(
			`UserMeter resource must be a daily entitlement resource; got ${JSON.stringify(resource)}.`,
		)
	}
	return resource
}

function dayKey(day: string) {
	if (!dayPattern.test(day)) {
		throw new Error(
			`UserMeter day must be a UTC YYYY-MM-DD key; got ${JSON.stringify(day)}.`,
		)
	}
	return day
}

/** Oldest live UTC day; earlier rows read as absent (the DO deleted them). */
function cutoffDay(at: string | undefined) {
	const parsed = at ? new Date(at) : new Date()
	const now = Number.isNaN(parsed.valueOf()) ? new Date() : parsed
	now.setUTCDate(now.getUTCDate() - (userMeterDailyCounterRetentionDays - 1))
	return utcDayKey(now)
}

const num = (item: Item | undefined, name: string) =>
	Math.max(0, Number(item?.[name]?.N ?? 0))
const str = (item: Item | undefined, name: string) => item?.[name]?.S

function readyState(count: number, revision: number): UserMeterReadyState {
	return {
		outcome: 'ready',
		count: Math.max(0, count),
		revision: Math.max(0, revision),
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(Math.max(0, revision)),
	}
}

function storageStateOf(
	bytes: number,
	revision: number,
): UserMeterStorageBytesReadyState {
	return {
		outcome: 'ready',
		bytes,
		revision,
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(revision),
	}
}

const storageState = (item: Item) =>
	storageStateOf(num(item, 'bytes'), num(item, 'revision'))

function pageSizeOf(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultPageSize
	return Math.min(Math.max(requested, 1), maxPageSize)
}

function decodePair(startAfter: string | null | undefined) {
	if (typeof startAfter !== 'string' || startAfter.length === 0) return null
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === 'string' &&
			typeof parsed[1] === 'string'
		) {
			return [parsed[0], parsed[1]] as const
		}
	} catch {}
	return null
}

const comparePairs = (
	a: readonly [string, string],
	b: readonly [string, string],
) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])

/**
 * UserMeter on the DynamoDB `meters` table: partition `userId`, one item per
 * former Durable Object row. Counters keep the DO's revision CAS, so
 * concurrent writers retry instead of overshooting a limit; multi-item
 * invariants (delivery claim + count, lease vs. deletion tombstone) use
 * `TransactWriteItems`. Missing counters still report `needs_bootstrap` so
 * callers seed them exactly as they seeded the DO.
 */
export function createDynamoUserMeters(options: {
	region: string
	tableName: string
	send?: DynamoSend
}): UserMeters {
	const send = dynamoSend(options)
	const TableName = options.tableName
	return { forUser: (userId) => userMeter(send, TableName, userId) }
}

function userMeter(
	send: DynamoSend,
	TableName: string,
	userId: string,
): UserMeterRpc {
	const Key = (sortKey: string) => ({ pk: { S: userId }, sk: { S: sortKey } })
	async function get(sortKey: string) {
		const { Item } = await send(
			new GetItemCommand({
				TableName,
				Key: Key(sortKey),
				ConsistentRead: true,
			}),
		)
		return Item
	}
	async function queryPrefix(prefix: string, between?: [string, string]) {
		const items: Array<Item> = []
		let ExclusiveStartKey: Item | undefined
		do {
			const page = await send(
				new QueryCommand({
					TableName,
					KeyConditionExpression: between
						? 'pk = :pk AND sk BETWEEN :from AND :to'
						: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: {
						':pk': { S: userId },
						...(between
							? { ':from': { S: between[0] }, ':to': { S: between[1] } }
							: { ':prefix': { S: prefix } }),
					},
					ConsistentRead: true,
					ExclusiveStartKey,
				}),
			)
			items.push(...(page.Items ?? []))
			ExclusiveStartKey = page.LastEvaluatedKey
		} while (ExclusiveStartKey)
		return items
	}
	/** Conditional write; returns the current item when the condition failed. */
	async function attempt(
		command: PutItemCommand | UpdateItemCommand | DeleteItemCommand,
	): Promise<{ ok: true; item?: Item } | { ok: false; item: Item | null }> {
		try {
			const { Attributes } = await send(command)
			return { ok: true, item: Attributes }
		} catch (error) {
			return { ok: false, item: conditionalCheckFailedItem(error) }
		}
	}
	const live = (item: Item | undefined, cutoff: string) =>
		item && (str(item, 'day') ?? '') >= cutoff ? item : undefined
	const readCounter = async (resource: string, day: string, cutoff: string) =>
		live(await get(sk.counter(resource, day)), cutoff)
	const dayExpiry = (day: string) => ({
		N: String(epochSeconds(Date.parse(`${day}T00:00:00Z`)) + dayTtlSeconds),
	})
	/** Overwrite allowed when absent or when the old row left the retention window. */
	const absentOrStale = 'attribute_not_exists(pk) OR #day < :cutoff'
	const casCounter = (
		resource: string,
		day: string,
		current: Item,
		count: number,
		updatedAt: string,
	) => ({
		TableName,
		Key: Key(sk.counter(resource, day)),
		UpdateExpression:
			'SET #count = :count, #revision = :next, #updatedAt = :updatedAt',
		ConditionExpression: '#revision = :revision',
		ExpressionAttributeNames: {
			'#count': 'count',
			'#revision': 'revision',
			'#updatedAt': 'updatedAt',
		},
		ExpressionAttributeValues: {
			':count': { N: String(count) },
			':next': { N: String(num(current, 'revision') + 1) },
			':revision': { N: String(num(current, 'revision')) },
			':updatedAt': { S: updatedAt },
		},
	})
	async function sumRange(
		resource: string,
		startDay: string,
		endDay: string,
		cutoff: string,
	) {
		const items = await queryPrefix('', [
			sk.counter(resource, startDay),
			sk.counter(resource, endDay),
		])
		return items
			.filter((item) => live(item, cutoff))
			.reduce((sum, item) => sum + num(item, 'count'), 0)
	}
	async function leases() {
		return (await queryPrefix('lease#'))
			.map((item) => ({
				token: str(item, 'token')!,
				holder: str(item, 'holder')!,
				acquiredAt: str(item, 'acquiredAt')!,
			}))
			.sort((a, b) =>
				comparePairs([a.acquiredAt, a.token], [b.acquiredAt, b.token]),
			)
	}
	const readDeletingAt = async () =>
		str(await get(sk.deletion), 'deletingAt') || null
	async function storageCas(
		current: Item,
		bytes: number,
		updatedAt: string,
		expectedRevision = num(current, 'revision'),
	) {
		return attempt(
			new UpdateItemCommand({
				TableName,
				Key: Key(sk.storage),
				UpdateExpression:
					'SET #bytes = :bytes, #revision = :next, #updatedAt = :updatedAt',
				ConditionExpression: '#revision = :revision',
				ExpressionAttributeNames: {
					'#bytes': 'bytes',
					'#revision': 'revision',
					'#updatedAt': 'updatedAt',
				},
				ExpressionAttributeValues: {
					':bytes': { N: String(bytes) },
					':next': { N: String(expectedRevision + 1) },
					':revision': { N: String(expectedRevision) },
					':updatedAt': { S: updatedAt },
				},
				ReturnValues: 'ALL_NEW',
				ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
			}),
		)
	}
	const putStorage = (bytes: number, updatedAt: string) =>
		attempt(
			new PutItemCommand({
				TableName,
				Item: {
					...Key(sk.storage),
					bytes: { N: String(bytes) },
					revision: { N: '1' },
					updatedAt: { S: updatedAt },
				},
				ConditionExpression: 'attribute_not_exists(pk)',
				ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
			}),
		)
	const raceLost = (method: string) =>
		new Error(`UserMeter ${method} lost the revision race too many times.`)

	async function readInboundConnectionLastUsed() {
		return (await queryPrefix('mcp_last_used#'))
			.map((item) => ({
				clientId: str(item, 'clientId')!,
				lastUsedAt: str(item, 'lastUsedAt')!,
			}))
			.sort(
				(a, b) =>
					b.lastUsedAt.localeCompare(a.lastUsedAt) ||
					a.clientId.localeCompare(b.clientId),
			)
	}

	return {
		async initialize(input) {
			const resource = dailyResource(input.resource)
			const day = dayKey(input.day)
			const count = Math.max(0, Math.trunc(Number(input.count) || 0))
			const result = await attempt(
				new PutItemCommand({
					TableName,
					Item: {
						...Key(sk.counter(resource, day)),
						day: { S: day },
						count: { N: String(count) },
						revision: { N: '1' },
						updatedAt: { S: input.updatedAt },
						expiresAt: dayExpiry(day),
					},
					ConditionExpression: absentOrStale,
					ExpressionAttributeNames: { '#day': 'day' },
					ExpressionAttributeValues: {
						':cutoff': { S: cutoffDay(input.updatedAt) },
					},
					ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
				}),
			)
			if (result.ok) return { ...readyState(count, 1), created: true }
			return {
				...readyState(
					num(result.item!, 'count'),
					num(result.item!, 'revision'),
				),
				created: false,
			}
		},
		async consume(input) {
			const resource = dailyResource(input.resource)
			const day = dayKey(input.day)
			const cutoff = cutoffDay(input.updatedAt)
			const weekLimit =
				typeof input.weekLimit === 'number' && Number.isFinite(input.weekLimit)
					? input.weekLimit
					: null
			const weekStart = input.weekStart ? dayKey(input.weekStart) : null
			for (let tries = 0; tries < maxCasAttempts; tries++) {
				const existing = await readCounter(resource, day, cutoff)
				if (!existing) return { outcome: 'needs_bootstrap' }
				const weekCount =
					weekStart && weekLimit !== null
						? await sumRange(resource, weekStart, day, cutoff)
						: undefined
				const count = num(existing, 'count')
				const current = readyState(count, num(existing, 'revision'))
				if (input.limit < 1 || count + 1 > input.limit) {
					return { ...current, consumed: false, deniedWindow: 'day', weekCount }
				}
				if (
					weekStart &&
					weekLimit !== null &&
					(weekLimit < 1 || (weekCount ?? 0) + 1 > weekLimit)
				) {
					return {
						...current,
						consumed: false,
						deniedWindow: 'week',
						weekCount,
					}
				}
				const result = await attempt(
					new UpdateItemCommand(
						casCounter(resource, day, existing, count + 1, input.updatedAt),
					),
				)
				if (result.ok) {
					return {
						...readyState(count + 1, current.revision + 1),
						consumed: true,
						weekCount: weekCount === undefined ? undefined : weekCount + 1,
					}
				}
			}
			throw raceLost('consume')
		},
		async readRange(input) {
			const resource = dailyResource(input.resource)
			return {
				outcome: 'ready',
				count: await sumRange(
					resource,
					dayKey(input.startDay),
					dayKey(input.endDay),
					cutoffDay(input.now),
				),
			}
		},
		async read(input) {
			const resource = dailyResource(input.resource)
			const row = await readCounter(
				resource,
				dayKey(input.day),
				cutoffDay(input.now),
			)
			if (!row) return { outcome: 'needs_bootstrap' }
			return readyState(num(row, 'count'), num(row, 'revision'))
		},
		async consumeInboundDelivery(input) {
			const resource = dailyResource(input.resource)
			if (resource !== inboundReceiveResource) {
				throw new Error(
					`UserMeter inbound delivery consume requires ${inboundReceiveResource}; got ${JSON.stringify(resource)}.`,
				)
			}
			const day = dayKey(input.day)
			const deliveryId = bounded('inbound deliveryId', input.deliveryId, 256)
			const cutoff = cutoffDay(input.updatedAt)
			for (let tries = 0; tries < maxCasAttempts; tries++) {
				const claim = live(await get(sk.delivery(deliveryId)), cutoff)
				if (claim) {
					if (str(claim, 'resource') !== resource) {
						throw new Error(
							`UserMeter inbound deliveryId was claimed for ${JSON.stringify(str(claim, 'resource'))}; cannot reuse for ${JSON.stringify(resource)}.`,
						)
					}
					const claimedDay = dayKey(str(claim, 'day')!)
					const row = await readCounter(resource, claimedDay, cutoff)
					return {
						...(row
							? readyState(num(row, 'count'), num(row, 'revision'))
							: readyState(num(claim, 'countAfter'), num(claim, 'revision'))),
						consumed: false,
						replayed: true,
						day: claimedDay,
						resource,
					}
				}
				const existing = await readCounter(resource, day, cutoff)
				if (!existing) return { outcome: 'needs_bootstrap' }
				const count = num(existing, 'count')
				const revision = num(existing, 'revision')
				if (input.limit < 1 || count + 1 > input.limit) {
					return {
						...readyState(count, revision),
						consumed: false,
						replayed: false,
						day,
						resource,
					}
				}
				try {
					await send(
						new TransactWriteItemsCommand({
							TransactItems: [
								{
									Update: casCounter(
										resource,
										day,
										existing,
										count + 1,
										input.updatedAt,
									),
								},
								{
									Put: {
										TableName,
										Item: {
											...Key(sk.delivery(deliveryId)),
											resource: { S: resource },
											day: { S: day },
											countAfter: { N: String(count + 1) },
											revision: { N: String(revision + 1) },
											claimedAt: { S: input.updatedAt },
											expiresAt: dayExpiry(day),
										},
										ConditionExpression: absentOrStale,
										ExpressionAttributeNames: { '#day': 'day' },
										ExpressionAttributeValues: { ':cutoff': { S: cutoff } },
									},
								},
							],
						}),
					)
					return {
						...readyState(count + 1, revision + 1),
						consumed: true,
						replayed: false,
						day,
						resource,
					}
				} catch (error) {
					transactionCancellationCodes(error)
				}
			}
			throw raceLost('consumeInboundDelivery')
		},
		async claimDynamicWorkerDay(input) {
			const workerId = bounded('dynamic worker id', input.workerId, 128)
			const day = dayKey(input.day)
			const result = await attempt(
				new PutItemCommand({
					TableName,
					Item: {
						...Key(sk.dynamicWorker(day, workerId)),
						day: { S: day },
						createdAt: { S: input.createdAt },
						expiresAt: dayExpiry(day),
					},
					ConditionExpression: absentOrStale,
					ExpressionAttributeNames: { '#day': 'day' },
					ExpressionAttributeValues: {
						':cutoff': { S: cutoffDay(input.createdAt) },
					},
				}),
			)
			return { created: result.ok }
		},
		async refund(input) {
			const resource = dailyResource(input.resource)
			const day = dayKey(input.day)
			const cutoff = cutoffDay(input.updatedAt)
			for (let tries = 0; tries < maxCasAttempts; tries++) {
				const existing = await readCounter(resource, day, cutoff)
				if (!existing) return readyState(0, 0)
				const count = Math.max(0, num(existing, 'count') - 1)
				const result = await attempt(
					new UpdateItemCommand(
						casCounter(resource, day, existing, count, input.updatedAt),
					),
				)
				if (result.ok) return readyState(count, num(existing, 'revision') + 1)
			}
			throw raceLost('refund')
		},
		async initializeStorageBytes(input) {
			const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
			const result = await putStorage(bytes, input.updatedAt)
			if (result.ok) {
				return { ...storageStateOf(bytes, 1), created: true }
			}
			return { ...storageState(result.item!), created: false }
		},
		async readStorageBytes() {
			const item = await get(sk.storage)
			return item ? storageState(item) : { outcome: 'needs_bootstrap' }
		},
		async reserveStorageBytes(input) {
			const requested = Math.max(0, Math.trunc(Number(input.requested) || 0))
			for (let tries = 0; tries < maxCasAttempts; tries++) {
				const existing = await get(sk.storage)
				if (!existing) return { outcome: 'needs_bootstrap' }
				const current = storageState(existing)
				if (
					requested > 0 &&
					(input.limit < 1 || current.bytes + requested > input.limit)
				) {
					return { ...current, reserved: false }
				}
				if (requested === 0) return { ...current, reserved: true }
				const result = await storageCas(
					existing,
					current.bytes + requested,
					input.updatedAt,
				)
				if (result.ok) return { ...storageState(result.item!), reserved: true }
			}
			throw raceLost('reserveStorageBytes')
		},
		async setStorageBytes(input) {
			const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
			for (let tries = 0; tries < maxCasAttempts; tries++) {
				const existing = await get(sk.storage)
				const result = existing
					? await storageCas(existing, bytes, input.updatedAt)
					: await putStorage(bytes, input.updatedAt)
				if (result.ok) {
					return existing
						? { ...storageState(result.item!), created: false }
						: { ...storageStateOf(bytes, 1), created: true }
				}
			}
			throw raceLost('setStorageBytes')
		},
		async reconcileStorageBytes(input) {
			const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
			const existing = await get(sk.storage)
			if (!existing) return { outcome: 'needs_bootstrap' }
			if (num(existing, 'revision') !== input.expectedRevision) {
				return { ...storageState(existing), applied: false }
			}
			const result = await storageCas(existing, bytes, input.updatedAt)
			return result.ok
				? { ...storageState(result.item!), applied: true }
				: { ...storageState(result.item!), applied: false }
		},
		async markDeleting(input) {
			const deletingAt = bounded('deletingAt', input.deletingAt, 64)
			const result = await attempt(
				new PutItemCommand({
					TableName,
					Item: { ...Key(sk.deletion), deletingAt: { S: deletingAt } },
					ConditionExpression: 'attribute_not_exists(pk)',
					ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
				}),
			)
			// Lease acquires are transactions conditioned on this tombstone, so the
			// count below sees every lease that can still be written.
			return {
				deletingAt: result.ok
					? deletingAt
					: (str(result.item ?? undefined, 'deletingAt') ?? deletingAt),
				created: result.ok,
				leaseCount: (await leases()).length,
			}
		},
		async clearDeleting(input) {
			const expected =
				input?.expectedDeletingAt == null
					? undefined
					: bounded('expectedDeletingAt', input.expectedDeletingAt, 64)
			const result = await attempt(
				new DeleteItemCommand({
					TableName,
					Key: Key(sk.deletion),
					ConditionExpression:
						expected === undefined
							? 'attribute_exists(pk)'
							: 'attribute_exists(pk) AND #deletingAt = :expected',
					...(expected === undefined
						? {}
						: {
								ExpressionAttributeNames: { '#deletingAt': 'deletingAt' },
								ExpressionAttributeValues: { ':expected': { S: expected } },
							}),
				}),
			)
			return { cleared: result.ok }
		},
		async acquireWriteLease(input) {
			const token = bounded('write lease token', input.token, 64)
			const holder = bounded('write lease holder', input.holder, 256)
			const acquiredAt = bounded('acquiredAt', input.acquiredAt, 64)
			try {
				await send(
					new TransactWriteItemsCommand({
						TransactItems: [
							{
								ConditionCheck: {
									TableName,
									Key: Key(sk.deletion),
									ConditionExpression: 'attribute_not_exists(pk)',
								},
							},
							{
								Put: {
									TableName,
									Item: {
										...Key(sk.lease(token)),
										token: { S: token },
										holder: { S: holder },
										acquiredAt: { S: acquiredAt },
									},
									ConditionExpression: 'attribute_not_exists(pk)',
								},
							},
						],
					}),
				)
				return { acquired: true }
			} catch (error) {
				// An existing lease stays held even after the tombstone appears.
				const [, lease] = transactionCancellationCodes(error)
				return { acquired: lease === 'ConditionalCheckFailed' }
			}
		},
		async releaseWriteLease(input) {
			const token = bounded('write lease token', input.token, 64)
			const result = await attempt(
				new DeleteItemCommand({
					TableName,
					Key: Key(sk.lease(token)),
					ConditionExpression: 'attribute_exists(pk)',
				}),
			)
			return { released: result.ok }
		},
		async assertWriteLeaseHeld(input) {
			const token = bounded('write lease token', input.token, 64)
			return { held: (await get(sk.lease(token))) !== undefined }
		},
		async prepareWriteLeaseRepair(input) {
			const token = bounded('write lease token', input.token, 64)
			const expected = bounded(
				'expectedAcquiredAt',
				input.expectedAcquiredAt,
				64,
			)
			const row = await get(sk.lease(token))
			if (!row) return { prepared: false }
			if (str(row, 'acquiredAt') !== expected) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			if (!str(row, 'pendingRepairId')) {
				await attempt(
					new UpdateItemCommand({
						TableName,
						Key: Key(sk.lease(token)),
						UpdateExpression: 'SET #pending = :repairId',
						ConditionExpression:
							'attribute_exists(pk) AND #acquiredAt = :expected AND attribute_not_exists(#pending)',
						ExpressionAttributeNames: {
							'#pending': 'pendingRepairId',
							'#acquiredAt': 'acquiredAt',
						},
						ExpressionAttributeValues: {
							':repairId': { S: crypto.randomUUID() },
							':expected': { S: expected },
						},
					}),
				)
			}
			const held = await get(sk.lease(token))
			if (!held) return { prepared: false }
			const repairId = str(held, 'pendingRepairId')
			if (!repairId) {
				throw new Error('Account write lease repair could not be prepared.')
			}
			return {
				prepared: true,
				repairId,
				token,
				holder: str(held, 'holder')!,
				acquiredAt: str(held, 'acquiredAt')!,
			}
		},
		async finalizeWriteLeaseRepair(input) {
			const token = bounded('write lease token', input.token, 64)
			const repairId = bounded('write lease repairId', input.repairId, 64)
			const expected = bounded(
				'expectedAcquiredAt',
				input.expectedAcquiredAt,
				64,
			)
			const mismatch = () =>
				new Error('Active account write lease did not match repair request.')
			const row = await get(sk.lease(token))
			if (!row) return { finalized: true }
			if (
				str(row, 'acquiredAt') !== expected ||
				str(row, 'pendingRepairId') !== repairId
			) {
				throw mismatch()
			}
			const result = await attempt(
				new DeleteItemCommand({
					TableName,
					Key: Key(sk.lease(token)),
					ConditionExpression:
						'#acquiredAt = :expected AND #pending = :repairId',
					ExpressionAttributeNames: {
						'#acquiredAt': 'acquiredAt',
						'#pending': 'pendingRepairId',
					},
					ExpressionAttributeValues: {
						':expected': { S: expected },
						':repairId': { S: repairId },
					},
				}),
			)
			if (!result.ok && (await get(sk.lease(token)))) throw mismatch()
			return { finalized: true }
		},
		async readDeletionState() {
			return { deletingAt: await readDeletingAt() }
		},
		async listWriteLeases(input = {}) {
			const pageSize = pageSizeOf(input.pageSize)
			const cursor = decodePair(input.startAfter)
			// ponytail: reads every lease item to page in (acquiredAt, token) order; add a GSI if a user ever holds thousands.
			const after = (await leases()).filter(
				(lease) =>
					!cursor || comparePairs([lease.acquiredAt, lease.token], cursor) > 0,
			)
			const page: Array<UserMeterWriteLeaseEntry> = after.slice(0, pageSize)
			const truncated = after.length > pageSize
			const last = page.at(-1)
			return {
				leases: page,
				nextStartAfter:
					truncated && last
						? JSON.stringify([last.acquiredAt, last.token])
						: null,
				truncated,
			}
		},
		async countActiveWriteLeases() {
			return { count: (await leases()).length }
		},
		async touchInboundConnectionLastUsed(input) {
			const clientId = bounded('inbound MCP client id', input.clientId, 1024)
			const lastUsedAt = input.lastUsedAt
			if (
				typeof lastUsedAt !== 'string' ||
				lastUsedAt.length === 0 ||
				lastUsedAt.length > 64 ||
				!Number.isFinite(Date.parse(lastUsedAt))
			) {
				throw new Error(
					`UserMeter inbound MCP last-used timestamp must be an ISO datetime; got ${JSON.stringify(lastUsedAt)}.`,
				)
			}
			const result = await attempt(
				new UpdateItemCommand({
					TableName,
					Key: Key(sk.lastUsed(clientId)),
					UpdateExpression:
						'SET #clientId = :clientId, #lastUsedAt = :lastUsedAt',
					ConditionExpression:
						'attribute_not_exists(pk) OR #lastUsedAt < :debounceCutoff',
					ExpressionAttributeNames: {
						'#clientId': 'clientId',
						'#lastUsedAt': 'lastUsedAt',
					},
					ExpressionAttributeValues: {
						':clientId': { S: clientId },
						':lastUsedAt': { S: lastUsedAt },
						':debounceCutoff': {
							S: new Date(
								Date.parse(lastUsedAt) -
									inboundMcpConnectionLastUsedMinIntervalMs,
							).toISOString(),
						},
					},
					ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
				}),
			)
			return {
				updated:
					result.ok ||
					str(result.item ?? undefined, 'lastUsedAt') === lastUsedAt,
			}
		},
		listInboundConnectionLastUsed: readInboundConnectionLastUsed,
		async forgetInboundConnectionLastUsed(input) {
			const clientId = bounded('inbound MCP client id', input.clientId, 1024)
			await send(
				new DeleteItemCommand({ TableName, Key: Key(sk.lastUsed(clientId)) }),
			)
			return { ok: true }
		},
		async purge() {
			// The deletion tombstone survives purge; origin drops it after the user row.
			for (const item of await queryPrefix('')) {
				if (item.sk?.S === sk.deletion) continue
				await send(new DeleteItemCommand({ TableName, Key: Key(item.sk!.S!) }))
			}
			return { ok: true }
		},
		async exportCounters(input) {
			const pageSize = pageSizeOf(input.pageSize)
			const cursor = decodePair(input.startAfter)
			const cutoff = cutoffDay(undefined)
			const rows: Array<UserMeterCounterRow> = []
			for (const resource of dailyEntitlementResources) {
				for (const item of await queryPrefix(`${resource}#`)) {
					if (!live(item, cutoff)) continue
					const revision = num(item, 'revision')
					rows.push({
						resource,
						day: str(item, 'day')!,
						count: num(item, 'count'),
						revision,
						updatedAt: str(item, 'updatedAt') ?? '',
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(revision),
					})
				}
			}
			const after = rows
				.sort((a, b) => comparePairs([a.day, a.resource], [b.day, b.resource]))
				.filter(
					(row) => !cursor || comparePairs([row.day, row.resource], cursor) > 0,
				)
			const counters = after.slice(0, pageSize)
			const truncated = after.length > pageSize
			const last = counters.at(-1)
			// Singleton and inventory state ride only on the first page.
			const first = cursor === null
			const storage = first ? await get(sk.storage) : undefined
			const allLeases = first ? await leases() : []
			return {
				counters,
				storageBytesState: storage
					? {
							bytes: num(storage, 'bytes'),
							revision: num(storage, 'revision'),
							updatedAt: str(storage, 'updatedAt') ?? '',
							mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(
								num(storage, 'revision'),
							),
						}
					: null,
				deletionState: first
					? {
							deletingAt: await readDeletingAt(),
							activeWriteLeaseCount: allLeases.length,
							writeLeases: allLeases.map(({ acquiredAt }) => ({ acquiredAt })),
						}
					: null,
				inboundConnectionLastUsed: first
					? await readInboundConnectionLastUsed()
					: null,
				nextStartAfter:
					truncated && last ? JSON.stringify([last.day, last.resource]) : null,
				truncated,
			}
		},
	}
}
