import {
	DeleteItemCommand,
	PutItemCommand,
	QueryCommand,
} from '@aws-sdk/client-dynamodb'
import { dynamoSend, type DynamoSend } from './dynamo.ts'

export type RealtimeSessionKey = { userId: string; packageId: string }
export type RealtimeSession = {
	id: string
	facet: string
	topics: string[]
	connectedAt: string
	lastSeenAt: string
}

export function createDynamoRealtimeSessions(input: {
	region: string
	tableName: string
	send?: DynamoSend
	now?: () => number
}) {
	const send = dynamoSend(input)
	const now = input.now ?? Date.now
	function partition(key: RealtimeSessionKey) {
		if (!key.userId.trim() || !key.packageId.trim())
			throw new Error('Realtime owner and package are required.')
		return JSON.stringify([key.userId, key.packageId])
	}
	const Key = (key: RealtimeSessionKey, id: string) => ({
		pk: { S: partition(key) },
		sk: { S: id },
	})
	async function list(key: RealtimeSessionKey): Promise<RealtimeSession[]> {
		const sessions: RealtimeSession[] = []
		let cursor
		do {
			const result = await send(
				new QueryCommand({
					TableName: input.tableName,
					KeyConditionExpression: 'pk = :pk',
					ExpressionAttributeValues: { ':pk': { S: partition(key) } },
					ConsistentRead: true,
					...(cursor ? { ExclusiveStartKey: cursor } : {}),
				}),
			)
			for (const item of result.Items ?? [])
				if (Number(item.expiresAt?.N) > now() / 1000 && item.data?.S)
					sessions.push(JSON.parse(item.data.S))
			cursor = result.LastEvaluatedKey
		} while (cursor)
		return sessions.sort((a, b) => a.id.localeCompare(b.id))
	}
	async function remove(key: RealtimeSessionKey, id: string) {
		await send(
			new DeleteItemCommand({ TableName: input.tableName, Key: Key(key, id) }),
		)
	}
	return {
		async put(key: RealtimeSessionKey, session: RealtimeSession) {
			if (!session.id.trim())
				throw new Error('Realtime session id is required.')
			// ponytail: 24-hour stale-session ceiling; refresh TTL on transport heartbeats when the WebSocket adapter is implemented.
			await send(
				new PutItemCommand({
					TableName: input.tableName,
					Item: {
						...Key(key, session.id),
						data: { S: JSON.stringify(session) },
						expiresAt: { N: String(Math.floor(now() / 1000) + 86_400) },
					},
				}),
			)
		},
		list,
		remove,
		async purge(key: RealtimeSessionKey) {
			for (const session of await list(key)) await remove(key, session.id)
		},
	}
}
export type RealtimeSessions = ReturnType<typeof createDynamoRealtimeSessions>
