import { type MailboxSql } from './mailbox-sql.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertOptionalMailboxCanonicalIsoTimestamp,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxPartialMutationResult,
	type MailboxSetMessageClassificationInput,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
} from './mailbox-types.ts'

/**
 * Owner-bound partial mutation helpers for Mailbox SQLite metadata.
 * No R2 / alarm side effects — callers own transactions.
 */

export async function touchMailboxThread(
	sql: MailboxSql,
	input: Omit<MailboxTouchThreadInput, 'ownerId'>,
): Promise<MailboxPartialMutationResult> {
	const threadId = assertMailboxNonEmptyString(input.threadId, 'threadId')
	const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
		input.lastMessageAt,
		'lastMessageAt',
	)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_threads WHERE id = ? LIMIT 1`,
			threadId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	await sql.exec(
		`UPDATE email_threads
		SET last_message_at = CASE
				WHEN last_message_at < ? THEN ?
				ELSE last_message_at
			END,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		lastMessageAt,
		lastMessageAt,
		updatedAt,
		threadId,
		updatedAt,
	)
	return { status: 'accepted' }
}

export async function updateMailboxMessageDelivery(
	sql: MailboxSql,
	input: Omit<MailboxUpdateMessageDeliveryInput, 'ownerId'>,
): Promise<MailboxPartialMutationResult> {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const processingStatus = assertMailboxProcessingStatus(input.processingStatus)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const sentAt = assertOptionalMailboxCanonicalIsoTimestamp(
		input.sentAt,
		'sentAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
			messageId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	await sql.exec(
		`UPDATE email_messages
		SET processing_status = ?,
			provider_message_id = ?,
			error = ?,
			sent_at = ?,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		processingStatus,
		input.providerMessageId,
		input.error,
		sentAt,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { status: 'accepted' }
}

export async function setMailboxMessageClassification(
	sql: MailboxSql,
	input: Omit<MailboxSetMessageClassificationInput, 'ownerId'>,
): Promise<MailboxPartialMutationResult> {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const classification = assertMailboxClassification(input.classification)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
			messageId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	await sql.exec(
		`UPDATE email_messages
		SET classification = ?,
			classification_reason = ?,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		classification,
		input.classificationReason,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { status: 'accepted' }
}

/**
 * Delete message + attachment metadata. Nulls delivery-event `message_id`
 * first so retained events cannot reference deleted metadata. Never deletes R2
 * or empty threads.
 */
export async function deleteMailboxMessageMetadata(
	sql: MailboxSql,
	input: Omit<MailboxDeleteMessageMetadataInput, 'ownerId'>,
): Promise<MailboxDeleteResult> {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages
			WHERE id = ?
			LIMIT 1`,
			messageId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	await sql.exec(
		`UPDATE email_delivery_events
		SET message_id = NULL
		WHERE message_id = ?`,
		messageId,
	)
	await sql.exec(
		`DELETE FROM email_attachments WHERE message_id = ?`,
		messageId,
	)
	await sql.exec(
		`DELETE FROM email_message_retention_retries WHERE message_id = ?`,
		messageId,
	)
	await sql.exec(
		`DELETE FROM email_messages
		WHERE id = ?
			AND updated_at <= ?`,
		messageId,
		deletedAt,
	)
	return { status: 'deleted' }
}

/**
 * Delete a delivery-event row. SELECT `updated_at` first so missing and stale
 * are distinguishable.
 */
export async function deleteMailboxDeliveryEvent(
	sql: MailboxSql,
	input: Omit<MailboxDeleteDeliveryEventInput, 'ownerId'>,
): Promise<MailboxDeleteResult> {
	const eventId = assertMailboxNonEmptyString(input.eventId, 'eventId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_delivery_events
			WHERE id = ?
			LIMIT 1`,
			eventId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	await sql.exec(
		`DELETE FROM email_delivery_events
		WHERE id = ?
			AND updated_at <= ?`,
		eventId,
		deletedAt,
	)
	return { status: 'deleted' }
}

/**
 * Delete a thread only when it has no messages. Stale-safe by
 * `thread.updated_at`. Not-empty / already-absent → `missing` (idempotent).
 */
export async function deleteMailboxThreadIfEmpty(
	sql: MailboxSql,
	input: Omit<MailboxDeleteThreadIfEmptyInput, 'ownerId'>,
): Promise<MailboxDeleteResult> {
	const threadId = assertMailboxNonEmptyString(input.threadId, 'threadId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = (
		await sql.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_threads
			WHERE id = ?
			LIMIT 1`,
			threadId,
		)
	).toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	const cursor = await sql.exec(
		`DELETE FROM email_threads
		WHERE id = ?
			AND updated_at <= ?
			AND NOT EXISTS (
				SELECT 1 FROM email_messages
				WHERE thread_id = ?
			)`,
		threadId,
		deletedAt,
		threadId,
	)
	return cursor.rowsWritten > 0 ? { status: 'deleted' } : { status: 'missing' }
}
