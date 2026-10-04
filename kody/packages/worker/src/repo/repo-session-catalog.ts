import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	UpdateItemCommand,
	type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
	conditionalCheckFailedItem,
	dynamoSend,
	type DynamoSend,
} from '#worker/aws/dynamo.ts'
import {
	isRepoSessionDue,
	nextOwnerDueAt,
	repoSessionCleanupReason,
} from './repo-session-due.ts'
import { replaceRepoSessionDueOwner } from './repo-session-due-owners.ts'
import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'
export type RepoSessionIndexExportResult = {
	rows: Array<RepoSessionRow>
	total: number
	truncated: boolean
	nextStartAfter: string | null
}

export type RepoSessionIndexCleanupResult = {
	checked: number
	deleted: number
	errors: number
}

export type RepoSessionIndexUpdateInput = {
	ownerId: string
	sessionId: string
	sessionBranch?: string | null
	sourceBranch?: string
	baseCommit?: string
	sourceRoot?: string
	conversationId?: string | null
	status?: RepoSessionRow['status']
	expiresAt?: string | null
	lastCheckpointAt?: string | null
	lastCheckpointCommit?: string | null
	lastCheckRunId?: string | null
	lastCheckTreeHash?: string | null
}

export type RepoSessionIndexRpc = {
	insertSession: (input: {
		ownerId: string
		row: RepoSessionRow
	}) => Promise<void>
	getSessionById: (input: {
		ownerId: string
		sessionId: string
	}) => Promise<RepoSessionRow | null>
	getActiveByConversation: (input: {
		ownerId: string
		conversationId: string
	}) => Promise<RepoSessionRow | null>
	listBySource: (input: {
		ownerId: string
		sourceId: string
	}) => Promise<Array<RepoSessionRow>>
	listByUser: (input: { ownerId: string }) => Promise<Array<RepoSessionRow>>
	updateSession: (input: RepoSessionIndexUpdateInput) => Promise<boolean>
	deleteSession: (input: {
		ownerId: string
		sessionId: string
	}) => Promise<boolean>
	deleteBySource: (input: {
		ownerId: string
		sourceId: string
	}) => Promise<number>
	countActive: (input: { ownerId: string }) => Promise<number>
	countAll: (input: { ownerId: string }) => Promise<number>
	hasActiveForSource: (input: {
		ownerId: string
		sourceId: string
	}) => Promise<boolean>
	runDueCleanup: (input: {
		ownerId: string
		now?: string
		limit?: number
	}) => Promise<RepoSessionIndexCleanupResult>
	exportSessions: (input: {
		ownerId: string
		pageSize?: number
		startAfter?: string | null
	}) => Promise<RepoSessionIndexExportResult>
	purge: (input: { ownerId: string }) => Promise<{ ok: true }>
}

/** Owner is captured at construction and checked on every operation, including reads. */
export function createRepoSessionCatalog(input: {
	region: string
	tableName: string
	ownerId: string
	db: SqlDatabase
	send?: DynamoSend
	cleanup: (
		sessionId: string,
		reason: 'expired' | 'abandoned',
	) => Promise<unknown>
}): RepoSessionIndexRpc {
	if (!input.ownerId) throw new Error('ownerId must be a non-empty string.')
	const send = dynamoSend(input)
	const TableName = input.tableName
	const pk = `${input.ownerId}:repo-sessions`
	const key = (id: string) => ({ pk: { S: pk }, sk: { S: id } })
	function owner(value: { ownerId: string }) {
		if (value.ownerId !== input.ownerId)
			throw new Error('RepoSession catalog ownerId mismatch.')
	}
	async function get(id: string) {
		const { Item } = await send(
			new GetItemCommand({ TableName, Key: key(id), ConsistentRead: true }),
		)
		return Item?.row?.S
			? repoSessionRowSchema.parse(JSON.parse(Item.row.S))
			: null
	}
	async function rows() {
		// ponytail: scans one owner's partition; add indexed selectors when session counts need bounded reads.
		const result: RepoSessionRow[] = []
		let cursor: Record<string, AttributeValue> | undefined
		do {
			const page = await send(
				new QueryCommand({
					TableName,
					KeyConditionExpression: 'pk = :pk',
					ExpressionAttributeValues: { ':pk': { S: pk } },
					ConsistentRead: true,
					ExclusiveStartKey: cursor,
				}),
			)
			for (const item of page.Items ?? [])
				result.push(repoSessionRowSchema.parse(JSON.parse(item.row!.S!)))
			cursor = page.LastEvaluatedKey
		} while (cursor)
		return result.sort(
			(a, b) =>
				b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
		)
	}
	async function due() {
		await replaceRepoSessionDueOwner({
			db: input.db,
			userId: input.ownerId,
			dueAt: nextOwnerDueAt(await rows()),
		})
	}
	async function del(id: string) {
		const existed = (await get(id)) !== null
		await send(new DeleteItemCommand({ TableName, Key: key(id) }))
		return existed
	}
	const catalog: RepoSessionIndexRpc = {
		async insertSession(value) {
			owner(value)
			if (value.row.user_id !== input.ownerId)
				throw new Error('RepoSession catalog row belongs to a different owner.')
			const row = repoSessionRowSchema.parse(value.row)
			try {
				await send(
					new PutItemCommand({
						TableName,
						Item: { ...key(row.id), row: { S: JSON.stringify(row) } },
						ConditionExpression: 'attribute_not_exists(pk)',
					}),
				)
			} catch (error) {
				conditionalCheckFailedItem(error)
			}
			await due()
		},
		async getSessionById(value) {
			owner(value)
			return get(value.sessionId)
		},
		async getActiveByConversation(value) {
			owner(value)
			return (
				(await rows()).find(
					(row) =>
						row.conversation_id === value.conversationId &&
						row.status === 'active',
				) ?? null
			)
		},
		async listBySource(value) {
			owner(value)
			return (await rows()).filter((row) => row.source_id === value.sourceId)
		},
		async listByUser(value) {
			owner(value)
			return rows()
		},
		async updateSession(value) {
			owner(value)
			const row = await get(value.sessionId)
			if (!row) return false
			const fields = {
				sessionBranch: 'session_branch',
				sourceBranch: 'source_branch',
				baseCommit: 'base_commit',
				sourceRoot: 'source_root',
				conversationId: 'conversation_id',
				status: 'status',
				expiresAt: 'expires_at',
				lastCheckpointAt: 'last_checkpoint_at',
				lastCheckpointCommit: 'last_checkpoint_commit',
				lastCheckRunId: 'last_check_run_id',
				lastCheckTreeHash: 'last_check_tree_hash',
			} as const
			const next = { ...row, updated_at: new Date().toISOString() }
			for (const [field, column] of Object.entries(fields)) {
				const update = value[field as keyof typeof fields]
				if (update !== undefined) Object.assign(next, { [column]: update })
			}
			repoSessionRowSchema.parse(next)
			// Compare-and-swap prevents overlapping activity writers losing checkpoints.
			await send(
				new UpdateItemCommand({
					TableName,
					Key: key(row.id),
					UpdateExpression: 'SET #row = :next',
					ConditionExpression: '#row = :previous',
					ExpressionAttributeNames: { '#row': 'row' },
					ExpressionAttributeValues: {
						':next': { S: JSON.stringify(next) },
						':previous': { S: JSON.stringify(row) },
					},
				}),
			)
			await due()
			return true
		},
		async deleteSession(value) {
			owner(value)
			const existed = await del(value.sessionId)
			await due()
			return existed
		},
		async deleteBySource(value) {
			owner(value)
			const selected = (await rows()).filter(
				(row) => row.source_id === value.sourceId,
			)
			for (const row of selected) await del(row.id)
			await due()
			return selected.length
		},
		async countActive(value) {
			owner(value)
			return (await rows()).filter((row) => row.status === 'active').length
		},
		async countAll(value) {
			owner(value)
			return (await rows()).length
		},
		async hasActiveForSource(value) {
			owner(value)
			return (await rows()).some(
				(row) => row.status === 'active' && row.source_id === value.sourceId,
			)
		},
		async runDueCleanup(value) {
			owner(value)
			const selected = (await rows())
				.filter((row) =>
					isRepoSessionDue(row, new Date(value.now ?? Date.now())),
				)
				.slice(0, value.limit ?? 100)
			let deleted = 0
			let errors = 0
			for (const row of selected) {
				try {
					await input.cleanup(row.id, repoSessionCleanupReason(row.status))
					deleted += 1
				} catch {
					errors += 1
				}
			}
			await due()
			return { checked: selected.length, deleted, errors }
		},
		async exportSessions(value) {
			owner(value)
			const all = await rows()
			const pageSize = Number.isFinite(value.pageSize)
				? Math.min(500, Math.max(1, Math.trunc(value.pageSize!)))
				: 100
			const selected = all
				.filter((row) => row.id > (value.startAfter ?? ''))
				.sort((a, b) => a.id.localeCompare(b.id))
			const truncated = selected.length > pageSize
			const page = selected.slice(0, pageSize)
			return {
				rows: page,
				total: all.length,
				truncated,
				nextStartAfter: truncated ? page.at(-1)!.id : null,
			}
		},
		async purge(value) {
			owner(value)
			for (const row of await rows()) await del(row.id)
			await due()
			return { ok: true }
		},
	}
	return catalog
}
