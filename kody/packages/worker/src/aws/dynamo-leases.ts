import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import {
	type DynamoSend,
	dynamoSend,
	conditionalCheckFailedItem,
} from './dynamo.ts'

type BucketKey = { userId: string; storageId: string }
export function createDynamoLeases(input: {
	region: string
	tableName: string
	send?: DynamoSend
	now?: () => number
	durationMs?: number
}) {
	const send = dynamoSend(input)
	const now = input.now ?? Date.now
	const duration = input.durationMs ?? 30_000
	const Key = (key: BucketKey) => ({
		pk: { S: key.userId },
		sk: { S: key.storageId },
	})
	async function read(key: BucketKey) {
		return (
			await send(
				new GetItemCommand({
					TableName: input.tableName,
					Key: Key(key),
					ConsistentRead: true,
				}),
			)
		).Item
	}
	return {
		async acquire(key: BucketKey & { ownerId: string }) {
			const current = await read(key)
			const timestamp = now()
			const sameLiveOwner =
				current?.ownerId?.S === key.ownerId &&
				Number(current?.leaseUntil?.N ?? 0) > timestamp
			if (!sameLiveOwner && Number(current?.leaseUntil?.N ?? 0) > timestamp)
				throw new Error('Storage lease is held by another cell.')
			const previous = Number(current?.fencingToken?.N ?? 0)
			const fencingToken = sameLiveOwner ? previous : previous + 1
			try {
				await send(
					new UpdateItemCommand({
						TableName: input.tableName,
						Key: Key(key),
						UpdateExpression:
							'SET ownerId = :owner, fencingToken = :next, leaseUntil = :until',
						ConditionExpression: current
							? 'fencingToken = :previous AND leaseUntil = :oldUntil AND ownerId = :oldOwner'
							: 'attribute_not_exists(pk)',
						ExpressionAttributeValues: {
							':owner': { S: key.ownerId },
							':next': { N: String(fencingToken) },
							':until': { N: String(timestamp + duration) },
							...(current
								? {
										':previous': { N: String(previous) },
										':oldUntil': current.leaseUntil!,
										':oldOwner': current.ownerId!,
									}
								: {}),
						},
					}),
				)
			} catch (error) {
				conditionalCheckFailedItem(error)
				throw new Error('Storage lease acquisition lost its fence.')
			}
			return { ownerId: key.ownerId, fencingToken }
		},
		async release(key: BucketKey & { ownerId: string; fencingToken: number }) {
			await send(
				new UpdateItemCommand({
					TableName: input.tableName,
					Key: Key(key),
					UpdateExpression: 'SET leaseUntil = :zero',
					ConditionExpression: 'ownerId = :owner AND fencingToken = :fence',
					ExpressionAttributeValues: {
						':zero': { N: '0' },
						':owner': { S: key.ownerId },
						':fence': { N: String(key.fencingToken) },
					},
				}),
			)
		},
		async assert(key: BucketKey & { ownerId: string; fencingToken: number }) {
			const current = await read(key)
			if (
				current?.ownerId?.S !== key.ownerId ||
				Number(current?.fencingToken?.N) !== key.fencingToken ||
				Number(current?.leaseUntil?.N ?? 0) <= now()
			)
				throw new Error('Storage lease is stale or expired.')
		},
	}
}
