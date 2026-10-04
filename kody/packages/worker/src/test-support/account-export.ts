import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	parseMailboxBlobRefCursor,
} from '#worker/email/mailbox-types.ts'
import { createPgDatabase, type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

type QueryObserver = {
	onQueryRows?: (rowCount: number) => void
	onQuery?: (query: string) => void
}

function observe(db: PgDatabase, observer: QueryObserver): PgDatabase {
	type Statement = ReturnType<PgDatabase['prepare']>
	const wrap = (statement: Statement): Statement => ({
		...statement,
		bind: (...values: Array<unknown>) => wrap(statement.bind(...values)),
		async all<T>() {
			const result = await statement.all<T>()
			observer.onQueryRows?.(result.results.length)
			return result
		},
	})
	return {
		...db,
		prepare(query: string) {
			observer.onQuery?.(query.replace(/\s+/g, ' ').trim())
			return wrap(db.prepare(query))
		},
	}
}

/**
 * PostgreSQL baseline for account export. Export reads through the subject's
 * `kody_subject_reader`; `db` exports `user-aaa`, `dbFor` any other subject.
 */
export async function createMigratedDb(observer: QueryObserver = {}) {
	const database = await createTestDb()
	const dbFor = (subject: string) =>
		observe(
			createPgDatabase({
				connection: database.pg,
				role: 'kody_subject_reader',
				userId: subject,
			}),
			observer,
		) as unknown as SqlDatabase
	return {
		pg: database.pg,
		exec: (sql: string) => database.pg.exec(sql),
		db: dbFor('user-aaa'),
		dbFor,
		[Symbol.asyncDispose]: () => database.pg.close(),
	}
}

export type TestMailboxBlobReference = {
	kind: 'raw_mime' | 'attachment'
	key: string
	messageId: string
	attachmentId: string | null
}

export function createMailboxBinding(input?: {
	blobReferences?: () => Array<TestMailboxBlobReference>
}) {
	const cursorAfter = (reference: TestMailboxBlobReference) =>
		reference.kind === 'raw_mime'
			? `${mailboxBlobRefRawMimeCursorPrefix}${reference.messageId}`
			: `${mailboxBlobRefAttachmentCursorPrefix}${reference.attachmentId}`
	const listBlobReferences = async ({
		pageSize = 100,
		startAfter,
	}: {
		pageSize?: number
		startAfter?: string | null
	}) => {
		const cursor = parseMailboxBlobRefCursor(startAfter ?? null)
		const references = (input?.blobReferences?.() ?? [])
			.filter((reference) => {
				if (cursor.phase === 'raw_mime') {
					return (
						reference.kind === 'attachment' ||
						reference.messageId > cursor.startAfterId
					)
				}
				return (
					reference.kind === 'attachment' &&
					(reference.attachmentId ?? '') > cursor.startAfterId
				)
			})
			.sort((left, right) => {
				if (left.kind !== right.kind) return left.kind === 'raw_mime' ? -1 : 1
				return cursorAfter(left).localeCompare(cursorAfter(right))
			})
		const page = references.slice(0, pageSize)
		const truncated = references.length > page.length
		return {
			references: page,
			nextStartAfter: truncated ? cursorAfter(page.at(-1)!) : null,
			truncated,
		}
	}
	return {
		forUser: (_name: string) => ({
			countMailbox: async () => ({
				threads: 0,
				messages: 0,
				attachments: 0,
				deliveryEvents: 0,
			}),
			exportMailbox: async () => ({
				rows: [],
				nextStartAfter: null,
				truncated: false,
			}),
			listBlobReferences,
		}),
	} as unknown as DurableObjectNamespace
}

export function encodeTestBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

export async function createSignedR2Cursor(input: {
	secret: string
	userId: string
	cursor: unknown
}) {
	const payload = encodeTestBase64Url(
		new TextEncoder().encode(
			JSON.stringify({ userId: input.userId, cursor: input.cursor }),
		),
	)
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(payload),
	)
	return `${payload}.${encodeTestBase64Url(new Uint8Array(signature))}`
}
