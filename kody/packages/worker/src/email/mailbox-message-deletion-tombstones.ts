import { type MailboxSql } from './mailbox-sql.ts'
import { deleteMailboxMessageMetadata } from './mailbox-mutations.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxNonEmptyString,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxTombstoneMissingMessageResult,
} from './mailbox-types.ts'

/**
 * Permanent fence against delayed writers resurrecting deleted messages.
 * Retain tombstones for the lifetime of the Mailbox.
 */
export async function isMailboxMessageTombstoned(
	sql: MailboxSql,
	messageId: string,
): Promise<boolean> {
	const id = assertMailboxNonEmptyString(messageId, 'messageId')
	return (
		(
			await sql.exec<{ found: number }>(
				`SELECT 1 AS found
				FROM email_message_deletion_tombstones
				WHERE message_id = ?
				LIMIT 1`,
				id,
			)
		).toArray()[0] != null
	)
}

export async function writeMailboxMessageDeletionTombstone(
	sql: MailboxSql,
	input: { messageId: string; deletedAt: string },
) {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	await sql.exec(
		`INSERT INTO email_message_deletion_tombstones (message_id, deleted_at)
		VALUES (?, ?)
		ON CONFLICT(message_id) DO UPDATE SET
			deleted_at = MAX(email_message_deletion_tombstones.deleted_at, excluded.deleted_at)`,
		messageId,
		deletedAt,
	)
}

/**
 * Fence a missing message without racing a newly accepted mirror. The caller
 * must wrap this check-and-write in a SQLite transaction.
 */
export async function tombstoneMissingMailboxMessage(
	sql: MailboxSql,
	input: { messageId: string; deletedAt: string },
): Promise<MailboxTombstoneMissingMessageResult> {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const messagePresent =
		(
			await sql.exec<{ found: number }>(
				`SELECT 1 AS found FROM email_messages WHERE id = ? LIMIT 1`,
				messageId,
			)
		).toArray()[0] != null
	if (messagePresent) return { status: 'message-present' }

	const created = !(await isMailboxMessageTombstoned(sql, messageId))
	await sql.exec(
		`UPDATE email_delivery_events
		SET message_id = NULL
		WHERE message_id = ?`,
		messageId,
	)
	await writeMailboxMessageDeletionTombstone(sql, { messageId, deletedAt })
	return { status: 'tombstoned', created }
}

/**
 * Apply stale-safe metadata deletion and permanently fence accepted/missing
 * targets from delayed mirror recreation.
 */
export async function deleteMailboxMessageMetadataWithTombstone(
	sql: MailboxSql,
	input: Omit<MailboxDeleteMessageMetadataInput, 'ownerId'>,
): Promise<MailboxDeleteResult> {
	const result = await deleteMailboxMessageMetadata(sql, input)
	if (result.status !== 'stale') {
		await writeMailboxMessageDeletionTombstone(sql, input)
	}
	return result
}
