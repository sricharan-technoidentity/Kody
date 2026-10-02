import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
	type InvocationLedger,
	type PackageInvocationLedgerKey,
	type PackageInvocationLedgerRecord,
} from '#worker/run-records/run-state-types.ts'
import {
	conditionalCheckFailedItem,
	dynamoSend,
	epochSeconds,
	type DynamoSend,
} from './dynamo.ts'
import { runRetentionSeconds } from './dynamo-runs.ts'

type Item = Record<string, AttributeValue>
const keyOf = (key: PackageInvocationLedgerKey) =>
	`invocation#${JSON.stringify([key.tokenId, key.packageId, key.exportName, key.idempotencyKey])}`
const recordOf = (item: Item): PackageInvocationLedgerRecord =>
	JSON.parse(item.record!.S!)

/** Conditional invocation claims retain the bounded HTTP response independently of Temporal retention. */
export function createDynamoInvocationLedger(options: {
	region: string
	tableName: string
	send?: DynamoSend
	now?: () => number
}): InvocationLedger {
	const send = dynamoSend(options)
	const now = options.now ?? Date.now
	return {
		forUser(userId) {
			if (!userId.trim())
				throw new Error('Invocation ledger requires a userId.')
			const key = (sk: string) => ({ pk: { S: userId }, sk: { S: sk } })
			const active = (item: Item) =>
				item.status?.S === 'in_progress' ||
				Number(item.expiresAt?.N) > epochSeconds(now())
			const get = async (sk: string) => {
				const result = await send(
					new GetItemCommand({
						TableName: options.tableName,
						Key: key(sk),
						ConsistentRead: true,
					}),
				)
				return result.Item && active(result.Item) ? result.Item : null
			}
			const listItems = async () => {
				const items: Array<Item> = []
				let cursor: Item | undefined
				do {
					const result = await send(
						new QueryCommand({
							TableName: options.tableName,
							KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
							ExpressionAttributeValues: {
								':pk': { S: userId },
								':prefix': { S: 'invocation#' },
							},
							ConsistentRead: true,
							ExclusiveStartKey: cursor,
						}),
					)
					items.push(...(result.Items ?? []))
					cursor = result.LastEvaluatedKey
				} while (cursor)
				return items
			}
			// ponytail: per-owner scan for finish/release; add an invocation-id GSI if one owner builds a large replay ledger.
			const byId = async (id: string) =>
				(await listItems()).find(
					(item) => active(item) && recordOf(item).id === id,
				) ?? null
			const put = async (
				sk: string,
				record: PackageInvocationLedgerRecord,
				previous: Item | null,
			) => {
				const expiresAt =
					epochSeconds(Date.parse(record.createdAt)) + runRetentionSeconds
				try {
					await send(
						new PutItemCommand({
							TableName: options.tableName,
							Item: {
								...key(sk),
								record: { S: JSON.stringify(record) },
								id: { S: record.id },
								status: { S: record.status },
								updatedAt: { S: record.updatedAt },
								...(record.status === 'in_progress'
									? {}
									: { expiresAt: { N: String(expiresAt) } }),
							},
							ConditionExpression: previous
								? 'id = :id AND updatedAt = :at AND #status = :status'
								: 'attribute_not_exists(pk) OR expiresAt <= :now',
							...(previous
								? {
										ExpressionAttributeNames: { '#status': 'status' },
										ExpressionAttributeValues: {
											':id': previous.id!,
											':at': previous.updatedAt!,
											':status': previous.status!,
										},
									}
								: {
										ExpressionAttributeValues: {
											':now': { N: String(epochSeconds(now())) },
										},
									}),
							ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
						}),
					)
					return true
				} catch (error) {
					conditionalCheckFailedItem(error)
					return false
				}
			}
			return {
				async claimPackageInvocation({ invocation, staleBefore }) {
					const sk = keyOf(invocation)
					for (;;) {
						const previous = await get(sk)
						const existing = previous && recordOf(previous)
						if (
							existing &&
							(existing.status !== 'in_progress' ||
								existing.requestHash !== invocation.requestHash ||
								existing.updatedAt > staleBefore)
						)
							return { outcome: 'existing', record: existing }
						const updatedAt = new Date(
							Math.max(
								now(),
								existing ? Date.parse(existing.updatedAt) + 1 : 0,
							),
						).toISOString()
						const record: PackageInvocationLedgerRecord = existing
							? { ...existing, updatedAt }
							: {
									...invocation,
									status: 'in_progress',
									responseJson: null,
									createdAt: updatedAt,
									updatedAt,
								}
						if (await put(sk, record, previous))
							return {
								outcome: 'claimed',
								invocationId: record.id,
								claimUpdatedAt: updatedAt,
								reclaimed: !!existing,
							}
					}
				},
				async getPackageInvocation(input) {
					const item = await get(keyOf(input))
					return item && recordOf(item)
				},
				async finishPackageInvocation(input) {
					const previous = await byId(input.invocationId)
					const record = previous && recordOf(previous)
					if (
						!record ||
						record.status !== 'in_progress' ||
						record.updatedAt !== input.claimUpdatedAt
					)
						return { ledgerUpdated: false, record }
					const updated = {
						...record,
						status: input.status,
						responseJson: input.responseJson,
						updatedAt: new Date(now()).toISOString(),
					}
					const ledgerUpdated = await put(previous!.sk!.S!, updated, previous)
					const current = ledgerUpdated ? null : await get(previous!.sk!.S!)
					return { ledgerUpdated, record: current && recordOf(current) }
				},
				async releasePackageInvocation(input) {
					const previous = await byId(input.invocationId)
					const record = previous && recordOf(previous)
					if (
						!record ||
						record.status !== 'in_progress' ||
						record.updatedAt !== input.claimUpdatedAt
					)
						return { released: false, record }
					try {
						await send(
							new DeleteItemCommand({
								TableName: options.tableName,
								Key: key(previous!.sk!.S!),
								ConditionExpression:
									'id = :id AND updatedAt = :at AND #status = :status',
								ExpressionAttributeNames: { '#status': 'status' },
								ExpressionAttributeValues: {
									':id': { S: input.invocationId },
									':at': { S: input.claimUpdatedAt },
									':status': { S: 'in_progress' },
								},
								ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
							}),
						)
						return { released: true, record: null }
					} catch (error) {
						const item = conditionalCheckFailedItem(error)
						return { released: false, record: item ? recordOf(item) : null }
					}
				},
				async list() {
					return (await listItems()).filter(active).map(recordOf)
				},
				async clear() {
					for (const item of await listItems())
						await send(
							new DeleteItemCommand({
								TableName: options.tableName,
								Key: key(item.sk!.S!),
							}),
						)
				},
			}
		},
	}
}
