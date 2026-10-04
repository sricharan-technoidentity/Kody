import { type PgDatabase } from '#worker/aws/pg-database.ts'

export type MailboxSqlValue = string | number | null | ArrayBuffer
export type MailboxSql = {
	exec<T = Record<string, MailboxSqlValue>>(
		sql: string,
		...values: MailboxSqlValue[]
	): Promise<{ toArray(): T[]; one(): T; rowsWritten: number }>
}
export type MailboxStorage = {
	sql: MailboxSql
	transaction<T>(run: () => Promise<T>): Promise<T>
	deleteAll(): Promise<void>
	getAlarm(): Promise<number | null>
	setAlarm(at: number): Promise<void>
	deleteAlarm(): Promise<void>
}
export type MailboxContext = {
	storage: MailboxStorage
	blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>
}
const tables = [
	'mailbox_meta',
	'mailbox_owner_identity',
	'email_message_deletion_tombstones',
	'email_threads',
	'email_messages',
	'email_outbound_provider_index_repairs',
	'email_message_retention_retries',
	'email_attachments',
	'email_delivery_events',
]

/** Async PostgreSQL cursor facade for the existing mail graph and CAS helpers. */
export function createMailboxContext(db: PgDatabase): MailboxContext {
	const storage: MailboxStorage = {
		sql: {
			async exec<T>(query: string, ...values: MailboxSqlValue[]) {
				for (const name of tables)
					query = query.replace(
						new RegExp(`\\b${name}\\b`, 'g'),
						`kody_mailbox.${name}`,
					)
				query = query.replace(
					/ON CONFLICT\(([^)]+)\)/g,
					'ON CONFLICT(user_id, $1)',
				)
				if (/INSERT OR IGNORE/.test(query))
					query =
						query.replace('INSERT OR IGNORE', 'INSERT') +
						' ON CONFLICT DO NOTHING'
				query = query.replace(
					/MAX\(kody_mailbox.email_message_deletion_tombstones.deleted_at, excluded.deleted_at\)/g,
					'GREATEST(kody_mailbox.email_message_deletion_tombstones.deleted_at, excluded.deleted_at)',
				)
				query = query.replace(
					/INSTR\((LOWER\((?:COALESCE\([^)]*\)|[^)]*)\)), \?\)/g,
					'STRPOS($1, ?)',
				)
				const result = await db
					.prepare(query)
					.bind(...values)
					.all<T>()
				return {
					toArray: () => result.results,
					one: () => {
						if (result.results.length !== 1)
							throw new Error('Expected exactly one SQL row.')
						return result.results[0]!
					},
					rowsWritten: result.meta.changes,
				}
			},
		},
		transaction: (run) => run(),
		async deleteAll() {
			for (const name of [...tables].reverse())
				await db.prepare(`DELETE FROM kody_mailbox.${name}`).run()
		},
		async getAlarm() {
			const row = await db
				.prepare(
					"SELECT value FROM kody_mailbox.mailbox_meta WHERE key = 'maintenance_at'",
				)
				.first<{ value: number }>()
			return row ? Number(row.value) : null
		},
		async setAlarm(at) {
			await db
				.prepare(
					"INSERT INTO kody_mailbox.mailbox_meta (key,value) VALUES ('maintenance_at',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value",
				)
				.bind(at)
				.run()
		},
		async deleteAlarm() {
			await db
				.prepare(
					"DELETE FROM kody_mailbox.mailbox_meta WHERE key = 'maintenance_at'",
				)
				.run()
		},
	}
	return { storage, blockConcurrencyWhile: (run) => run() }
}
