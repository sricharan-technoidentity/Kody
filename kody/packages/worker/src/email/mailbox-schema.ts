import { type MailboxStorage } from './mailbox-sql.ts'
import {
	mailboxMetaSchemaVersionKey,
	mailboxSchemaVersion,
} from './mailbox-types.ts'

export async function getMailboxMeta(
	storage: MailboxStorage,
	key: string,
): Promise<number | null> {
	const row = (
		await storage.sql.exec<{ value: number }>(
			`SELECT value FROM mailbox_meta WHERE key = ? LIMIT 1`,
			key,
		)
	).toArray()[0]
	return row == null ? null : Number(row.value) || 0
}

export async function setMailboxMeta(
	storage: MailboxStorage,
	key: string,
	value: number,
) {
	await storage.sql.exec(
		`INSERT INTO mailbox_meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key,
		value,
	)
}

export async function initializeMailboxSchema(storage: MailboxStorage) {
	await setMailboxMeta(
		storage,
		mailboxMetaSchemaVersionKey,
		mailboxSchemaVersion,
	)
}
