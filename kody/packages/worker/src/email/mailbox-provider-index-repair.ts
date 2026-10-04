import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { type MailboxSql } from './mailbox-sql.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { upsertOutboundProviderIndexRow } from './outbound-provider-index.ts'

export const mailboxProviderIndexRepairInitialDelayMs = 60_000
export const mailboxProviderIndexRepairMaxDelayMs = 60 * 60 * 1000
export const mailboxProviderIndexRepairBatchSize = 10

export type MailboxProviderIndexRepairInput = {
	provider: string
	providerMessageId: string
	messageId: string
	inboxId: string | null
	createdAt: string
}

export type MailboxProviderIndexRepairStatus = {
	pendingCount: number
	oldestPendingAt: string | null
	nextRetryAt: string | null
}

type PendingRepairRow = {
	provider: string
	provider_message_id: string
	message_id: string
	inbox_id: string | null
	created_at: string
	attempt_count: number
}

function nextRetryAt(now: Date, attemptCount: number) {
	const delay = Math.min(
		mailboxProviderIndexRepairInitialDelayMs *
			2 ** Math.min(Math.max(attemptCount, 0), 10),
		mailboxProviderIndexRepairMaxDelayMs,
	)
	return new Date(now.getTime() + delay).toISOString()
}

export async function upsertMailboxProviderIndexRepair(
	sql: MailboxSql,
	input: MailboxProviderIndexRepairInput,
) {
	await sql.exec(
		`INSERT INTO email_outbound_provider_index_repairs (
			provider, provider_message_id, message_id, inbox_id, created_at,
			updated_at, retry_at, attempt_count, last_error
		) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
		ON CONFLICT(provider, provider_message_id) DO UPDATE SET
			message_id = excluded.message_id,
			inbox_id = excluded.inbox_id,
			updated_at = excluded.updated_at`,
		input.provider,
		input.providerMessageId,
		input.messageId,
		input.inboxId,
		input.createdAt,
		input.createdAt,
		new Date(
			Date.parse(input.createdAt) + mailboxProviderIndexRepairInitialDelayMs,
		).toISOString(),
	)
}

export async function clearMailboxProviderIndexRepair(
	sql: MailboxSql,
	input: { provider: string; providerMessageId: string },
) {
	const row = (
		await sql.exec<{ changes: number }>(
			`DELETE FROM email_outbound_provider_index_repairs
			WHERE provider = ? AND provider_message_id = ?
			RETURNING 1 AS changes`,
			input.provider,
			input.providerMessageId,
		)
	).toArray()[0]
	return row != null
}

export async function getMailboxProviderIndexRepairStatus(
	sql: MailboxSql,
): Promise<MailboxProviderIndexRepairStatus> {
	const row = (
		await sql.exec<{
			pending_count: number
			oldest_pending_at: string | null
			next_retry_at: string | null
		}>(
			`SELECT
				COUNT(*) AS pending_count,
				MIN(created_at) AS oldest_pending_at,
				MIN(retry_at) AS next_retry_at
			FROM email_outbound_provider_index_repairs`,
		)
	).one()
	return {
		pendingCount: Number(row.pending_count),
		oldestPendingAt: row.oldest_pending_at,
		nextRetryAt: row.next_retry_at,
	}
}

export async function nextMailboxProviderIndexRepairDueAtMs(
	sql: MailboxSql,
): Promise<number | null> {
	const retryAt = (await getMailboxProviderIndexRepairStatus(sql)).nextRetryAt
	if (!retryAt) return null
	const parsed = Date.parse(retryAt)
	return Number.isFinite(parsed) ? parsed : Date.now()
}

export async function repairPendingMailboxProviderIndexes(input: {
	sql: MailboxSql
	db: SqlDatabase
	ownerId: string
	now?: Date
	limit?: number
}): Promise<{ attempted: number; repaired: number; failed: number }> {
	const now = input.now ?? new Date()
	const rows = (
		await input.sql.exec<PendingRepairRow>(
			`SELECT provider, provider_message_id, message_id, inbox_id,
				created_at, attempt_count
			FROM email_outbound_provider_index_repairs
			WHERE retry_at <= ?
			ORDER BY retry_at ASC, provider ASC, provider_message_id ASC
			LIMIT ?`,
			now.toISOString(),
			input.limit ?? mailboxProviderIndexRepairBatchSize,
		)
	).toArray()
	let repaired = 0
	let failed = 0
	for (const row of rows) {
		try {
			await upsertOutboundProviderIndexRow({
				db: input.db,
				provider: row.provider,
				providerMessageId: row.provider_message_id,
				userId: input.ownerId,
				messageId: row.message_id,
				inboxId: row.inbox_id,
				now: now.toISOString(),
			})
			await clearMailboxProviderIndexRepair(input.sql, {
				provider: row.provider,
				providerMessageId: row.provider_message_id,
			})
			repaired += 1
		} catch (error) {
			const attemptCount = row.attempt_count + 1
			await input.sql.exec(
				`UPDATE email_outbound_provider_index_repairs
				SET attempt_count = ?, last_error = ?, retry_at = ?, updated_at = ?
				WHERE provider = ? AND provider_message_id = ?`,
				attemptCount,
				getErrorMessage(error).slice(0, 1000),
				nextRetryAt(now, attemptCount),
				now.toISOString(),
				row.provider,
				row.provider_message_id,
			)
			failed += 1
		}
	}
	return { attempted: rows.length, repaired, failed }
}
