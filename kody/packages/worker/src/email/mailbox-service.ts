import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { scheduleMailboxMaintenance } from './mailbox-scheduling.ts'
import { createMailboxContext } from './mailbox-sql.ts'
import { type MailboxContext } from './mailbox-sql.ts'
import {
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	canonicalMailboxMessageBlobReferences,
	deleteMailboxBlobKeys,
} from './mailbox-retention.ts'
import { MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import { MailboxGraphCommitCommands } from './mailbox-graph-commit-commands.ts'
import { MailboxInboundCommands } from './mailbox-inbound-commands.ts'
import { MailboxStore } from './mailbox-store.ts'
import {
	deleteMailboxDeliveryEvent,
	deleteMailboxThreadIfEmpty,
	setMailboxMessageClassification,
	touchMailboxThread,
	updateMailboxMessageDelivery,
} from './mailbox-mutations.ts'
import { findDeliveryEventByProviderEventId } from './mailbox-delivery-events.ts'
import {
	deleteMailboxMessageMetadataWithTombstone,
	tombstoneMissingMailboxMessage,
} from './mailbox-message-deletion-tombstones.ts'
import { upsertMailboxDeliveryEvents } from './mailbox-delivery-event-upsert.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxCommitInboundMessageGraphResult,
	type MailboxCommitOutboundTerminalInput,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageWithBlobsResult,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxInboundDeliveryState,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRpc,
	type MailboxRunRetentionNowResult,
	type MailboxSearchMessagesInput,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTombstoneMissingMessageResult,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertDeliveryEventsResult,
	type MailboxUpsertMessageGraphInput,
} from './mailbox-types.ts'

/**
 * Per-owner Mailbox Durable Object: SQLite metadata for threads, messages,
 * attachments, and delivery events. Object identity is ownership — no
 * `user_id` columns on data rows. Owner binding for blob-key validation is
 * a singleton identity row (DO name is not introspectable). Raw MIME /
 * external attachment bytes stay in `EMAIL_BLOBS`; rows retain keys.
 * `system:email` stays in D1 by design.
 *
 * USER graph reads/writes and inbound ledger/effect transitions are
 * authoritative here; `system:email` remains on its dedicated D1 graph.
 */

export class MailboxService implements MailboxRpc {
	private readonly store: MailboxStore
	private readonly maintenance: MailboxMaintenanceCommands
	private readonly graphCommits: MailboxGraphCommitCommands
	private readonly inbound: MailboxInboundCommands

	private readonly ctx: MailboxContext
	private readonly env: Env
	constructor(ctx: MailboxContext, env: Env) {
		this.ctx = ctx
		this.env = env
		this.store = new MailboxStore(ctx.storage)
		this.maintenance = new MailboxMaintenanceCommands(ctx, env, this.store)
		this.graphCommits = new MailboxGraphCommitCommands(
			ctx,
			this.store,
			this.maintenance,
		)
		this.inbound = new MailboxInboundCommands(ctx, this.store, this.maintenance)
	}

	private async assertReadable(): Promise<void> {
		await this.store.assertReadable()
	}

	async alarm(): Promise<void> {
		await this.maintenance.blockConcurrencySafely(async () => {
			if (await this.store.isRestorePending()) return
			await this.maintenance.alarm()
		})
	}

	/**
	 * Owner-bound retention pass (natural cutoffs only). Same scheduling as
	 * `alarm`; returns before/after counts with no row ids or content.
	 */
	async runRetentionNow(input: {
		ownerId: string
	}): Promise<MailboxRunRetentionNowResult> {
		await this.assertReadable()
		return await this.maintenance.runRetentionNow(input.ownerId)
	}

	async upsertMessageGraph(
		input: MailboxUpsertMessageGraphInput,
	): Promise<{ ok: true; accepted: boolean }> {
		return await this.graphCommits.upsertMessageGraph(input)
	}

	async commitInboundMessageGraph(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}): Promise<MailboxCommitInboundMessageGraphResult> {
		await this.assertReadable()
		return await this.graphCommits.commitInboundMessageGraph(input)
	}

	async commitOutboundTerminal(
		input: MailboxCommitOutboundTerminalInput,
	): Promise<{ message: MailboxMessageRecord; eventInserted: boolean }> {
		await this.assertReadable()
		return await this.graphCommits.commitOutboundTerminal(input)
	}

	async completeOutboundProviderIndexRepair(input: {
		ownerId: string
		provider: string
		providerMessageId: string
	}): Promise<{ cleared: boolean }> {
		await this.assertReadable()
		return await this.graphCommits.completeOutboundProviderIndexRepair(input)
	}

	async getOutboundProviderIndexRepairStatus(input: { ownerId: string }) {
		await this.assertReadable()
		return await this.graphCommits.getOutboundProviderIndexRepairStatus(
			input.ownerId,
		)
	}

	async recordBoundedRejection(input: {
		ownerId: string
		inboxId: string
		recipient: string
		reason: string
		phase: string
		day: string
		now: string
		detailLimit: number
		detailEventId: string
	}): Promise<{ count: number; detailed: boolean }> {
		await this.assertReadable()
		let count = 0
		let detailed = false
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const aggregateId = `email-rejections:${input.inboxId}:${input.day}`
			const existing = (
				await this.ctx.storage.sql.exec<{ detail_json: string }>(
					`SELECT detail_json FROM email_delivery_events
					WHERE id = ?
					LIMIT 1`,
					aggregateId,
				)
			).toArray()[0]
			let priorCount = 0
			if (existing) {
				try {
					const detail = JSON.parse(existing.detail_json) as {
						count?: unknown
					}
					if (typeof detail.count === 'number') priorCount = detail.count
				} catch {
					priorCount = 0
				}
			}
			count = priorCount + 1
			const event = (
				id: string,
				detailJson: string,
			): MailboxDeliveryEventInput => ({
				id,
				messageId: null,
				inboxId: input.inboxId,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				providerMessageId: null,
				providerEventId: null,
				detailJson,
				needsEffectReconcile: false,
				state: null,
				fingerprint: null,
				storageLease: null,
				storageLeaseAt: null,
				cleanupLease: null,
				cleanupLeaseAt: null,
				cleanupRetryAt: null,
				expectedAttachmentCount: null,
				finalizationToken: null,
				reconcileAfter: null,
				dedupeExpiresAt: null,
				usageEffectRecordedAt: null,
				usageEffectSuppressedAt: null,
				usageStartedAt: null,
				usageMonth: null,
				usageBytes: null,
				usageDurationMs: null,
				usageEffectRetryAt: null,
				usageEffectLease: null,
				usageEffectLeaseAt: null,
				subscriptionEffectState: null,
				subscriptionEffectLease: null,
				subscriptionEffectLeaseAt: null,
				subscriptionEffectRetryAt: null,
				subscriptionEffectAttemptCount: null,
				subscriptionEffectDeadLetterAt: null,
				subscriptionEffectLastError: null,
				createdAt: input.now,
				updatedAt: input.now,
			})
			await this.store.writeDeliveryEventRow(
				event(
					aggregateId,
					JSON.stringify({
						aggregate: true,
						day: input.day,
						count,
						last_reason: input.reason,
						last_phase: input.phase,
						last_at: input.now,
					}),
				),
			)
			if (count <= Math.max(0, Math.trunc(input.detailLimit))) {
				detailed = (
					await this.store.writeDeliveryEventRow(
						event(
							input.detailEventId,
							JSON.stringify({
								recipient: input.recipient,
								reason: input.reason,
								phase: input.phase,
							}),
						),
					)
				).inserted
			}
		})
		await this.maintenance.markDirtyAndEnsure()
		return { count, detailed }
	}

	async upsertDeliveryEvent(input: {
		ownerId: string
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}): Promise<{
		inserted: boolean
		accepted: boolean
		updatedLatestStatus: boolean
	}> {
		await this.assertReadable()
		let inserted = false
		let accepted = false
		let updatedLatestStatus = false
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			if (
				await shouldSkipMailboxDeliveryEventWrite(this.ctx.storage.sql, {
					event: input.event,
				})
			) {
				return
			}
			const write = await this.store.writeDeliveryEventRow(input.event)
			inserted = write.inserted
			accepted = write.accepted
			if (accepted && input.latestDeliveryStatus) {
				const eventId = assertMailboxNonEmptyString(input.event.id, 'event.id')
				const messageId = assertMailboxNonEmptyString(
					input.latestDeliveryStatus.messageId,
					'latestDeliveryStatus.messageId',
				)
				if (await this.store.deliveryEventOwnsMessage(eventId, messageId)) {
					updatedLatestStatus = await this.store.updateLatestDeliveryStatus(
						input.latestDeliveryStatus,
					)
				}
			}
		})
		await this.maintenance.markDirtyAndEnsure()
		return { inserted, accepted, updatedLatestStatus }
	}

	async upsertDeliveryEvents(input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
		restore?: true
	}): Promise<MailboxUpsertDeliveryEventsResult> {
		if (!input.restore) await this.assertReadable()
		let result: MailboxUpsertDeliveryEventsResult | undefined
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await upsertMailboxDeliveryEvents(
				this.ctx.storage.sql,
				input.events,
				{
					restore: input.restore,
				},
			)
		})
		if (!result) throw new Error('Mailbox upsert transaction did not run.')
		if (!input.restore) await this.maintenance.markDirtyAndEnsure()
		return result
	}

	/**
	 * Advance thread activity without a full snapshot. Equal/newer `updatedAt`
	 * only; `last_message_at` never moves backward.
	 */
	async touchThread(
		input: MailboxTouchThreadInput,
	): Promise<MailboxPartialMutationResult> {
		await this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await touchMailboxThread(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Partial authoritative delivery/processing update. Equal/newer `updatedAt`
	 * only.
	 */
	async updateMessageDelivery(
		input: MailboxUpdateMessageDeliveryInput,
	): Promise<MailboxPartialMutationResult> {
		await this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await updateMailboxMessageDelivery(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Partial authoritative classification update. Equal/newer `updatedAt` only.
	 */
	async setMessageClassification(
		input: MailboxSetMessageClassificationInput,
	): Promise<MailboxPartialMutationResult> {
		await this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await setMailboxMessageClassification(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Metadata-only delete (null delivery-event message_id + attachments +
	 * message). Never deletes R2 or empty threads.
	 */
	async deleteMessageMetadata(
		input: MailboxDeleteMessageMetadataInput,
	): Promise<MailboxDeleteResult> {
		await this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await deleteMailboxMessageMetadataWithTombstone(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Delete canonical owner-safe R2 objects before atomically deleting one
	 * message graph. Blocking input concurrency prevents an update from
	 * interleaving across the asynchronous R2 delete boundary.
	 */
	async deleteMessageWithBlobs(input: {
		ownerId: string
		messageId: string
	}): Promise<MailboxDeleteMessageWithBlobsResult> {
		await this.assertReadable()
		return await this.maintenance.blockConcurrencySafely(async () => {
			const ownerId = await this.store.assertOwner(input.ownerId)
			const messageId = assertMailboxNonEmptyString(
				input.messageId,
				'messageId',
			)
			const message = await this.store.getMessage(messageId)
			if (!message) {
				return {
					status: 'missing',
					tombstoned: await this.store.isMessageTombstoned(messageId),
				}
			}

			const attachments = await this.store.listAttachmentsForMessage(messageId)
			const blobReferences = canonicalMailboxMessageBlobReferences({
				ownerId,
				messageId,
				direction: message.direction,
				attachments: attachments.map((attachment) => ({
					id: attachment.id,
					storage_key: attachment.storageKey,
				})),
			})
			await deleteMailboxBlobKeys(
				this.env.EMAIL_BLOBS,
				blobReferences.map((reference) => reference.key),
			)

			await this.store.tombstoneAndDeleteMessage({
				messageId,
				deletedAt: new Date().toISOString(),
			})
			return {
				status: 'deleted',
				providerMessageId: message.providerMessageId,
				attachmentsSeen: attachments.length,
				externalAttachmentsSeen: attachments.filter(
					(attachment) => attachment.storageKind === 'external',
				).length,
				blobReferences,
			}
		})
	}

	async tombstoneMissingMessage(input: {
		ownerId: string
		messageId: string
		deletedAt: string
	}): Promise<MailboxTombstoneMissingMessageResult> {
		await this.assertReadable()
		let result: MailboxTombstoneMissingMessageResult = {
			status: 'message-present',
		}
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await tombstoneMissingMailboxMessage(this.ctx.storage.sql, input)
		})
		return result
	}

	/**
	 * Metadata-only delivery-event delete. Distinguishes missing (idempotent)
	 * from stale (newer `updated_at` retained).
	 */
	async deleteDeliveryEvent(
		input: MailboxDeleteDeliveryEventInput,
	): Promise<MailboxDeleteResult> {
		await this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await deleteMailboxDeliveryEvent(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Deferred empty-thread cleanup. Stale-safe by `thread.updated_at`.
	 */
	async deleteThreadIfEmpty(
		input: MailboxDeleteThreadIfEmptyInput,
	): Promise<MailboxDeleteResult> {
		await this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = await deleteMailboxThreadIfEmpty(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	async getThread(input: {
		threadId: string
	}): Promise<MailboxThreadRecord | null> {
		await this.assertReadable()
		return await this.store.getThread(input.threadId)
	}

	async findThreadForInboundMessage(input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}): Promise<MailboxThreadRecord | null> {
		await this.assertReadable()
		return await this.store.findThreadForInboundMessage(input)
	}

	async getMessage(input: {
		messageId: string
	}): Promise<MailboxMessageRecord | null> {
		await this.assertReadable()
		return await this.store.getMessage(input.messageId)
	}

	async getMessageByMessageIdHeader(input: {
		messageIdHeader: string
	}): Promise<MailboxMessageRecord | null> {
		await this.assertReadable()
		return await this.store.getMessageByMessageIdHeader(input.messageIdHeader)
	}

	async getOutboundMessageByProviderMessageId(input: {
		providerMessageId: string
	}): Promise<MailboxMessageRecord | null> {
		await this.assertReadable()
		return await this.store.getOutboundMessageByProviderMessageId(
			input.providerMessageId,
		)
	}

	async listMessages(input: MailboxListMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	}> {
		await this.assertReadable()
		return await this.store.listMessages(input)
	}

	async searchMessages(input: MailboxSearchMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
	}> {
		await this.assertReadable()
		return await this.store.searchMessages(input)
	}

	async countMessages(
		input: MailboxCountMessagesInput,
	): Promise<{ total: number }> {
		await this.assertReadable()
		return await this.store.countMessages(input)
	}

	async getAttachment(input: {
		attachmentId: string
	}): Promise<MailboxAttachmentRecord | null> {
		await this.assertReadable()
		return await this.store.getAttachment(input.attachmentId)
	}

	async listAttachmentsForMessage(input: {
		messageId: string
	}): Promise<Array<MailboxAttachmentRecord>> {
		await this.assertReadable()
		return await this.store.listAttachmentsForMessage(input.messageId)
	}

	async listDeliveryEvents(input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}): Promise<Array<MailboxDeliveryEventRecord>> {
		await this.assertReadable()
		return await this.store.listDeliveryEvents(input)
	}

	async countDeliveryEvents(input: {
		ownerId: string
		eventType: EmailDeliveryEventType
		provider: string
		createdAtGte: string
	}): Promise<{ count: number }> {
		await this.store.assertOwner(input.ownerId)
		await this.assertReadable()
		const row = (
			await this.ctx.storage.sql.exec<{ count: number }>(
				`SELECT COUNT(*) AS count
				FROM email_delivery_events
				WHERE event_type = ?
					AND provider = ?
					AND created_at >= ?`,
				input.eventType,
				input.provider,
				input.createdAtGte,
			)
		).one()
		return { count: Number(row.count) }
	}

	async getDeliveryEventByProviderEventId(input: {
		providerEventId: string
	}): Promise<MailboxDeliveryEventRecord | null> {
		await this.assertReadable()
		return await findDeliveryEventByProviderEventId(
			this.ctx.storage.sql,
			input.providerEventId,
		)
	}

	async countMailbox(input?: { restore?: true }): Promise<MailboxCountResult> {
		if (!input?.restore) await this.assertReadable()
		return await this.store.countMailbox()
	}

	async inspectRestoreState(input: { ownerId: string }) {
		await this.store.assertOwner(input.ownerId)
		return await this.store.inspectRestoreState()
	}

	async beginRestore(input: { ownerId: string }): Promise<{ ok: true }> {
		await this.store.beginRestore(input.ownerId)
		return { ok: true }
	}

	async finalizeRestore(input: { ownerId: string }): Promise<{ ok: true }> {
		await this.store.finalizeRestore(input.ownerId)
		await this.maintenance.markDirtyAndEnsure()
		return { ok: true }
	}

	async readDrillResult(input: {
		ownerId: string
	}): Promise<MailboxCountResult | null> {
		await this.store.assertOwner(input.ownerId)
		return await this.store.readDrillResult()
	}

	async completeDrill(input: {
		ownerId: string
		result: MailboxCountResult
	}): Promise<{ ok: true }> {
		await this.maintenance.blockConcurrencySafely(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			await this.store.completeDrill(input.ownerId, input.result)
		})
		return { ok: true }
	}

	async exportMailbox(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxExportResult> {
		await this.assertReadable()
		return await this.store.exportMailbox(input)
	}

	async listBlobReferences(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxBlobReferencePage> {
		await this.assertReadable()
		return await this.store.listBlobReferences(input)
	}

	async getInboundDelivery(input: {
		ownerId: string
		deliveryId: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		await this.assertReadable()
		return await this.inbound.getInboundDelivery(input)
	}

	async getInboundDeliveryWindow(input: {
		ownerId: string
		fingerprint: string
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		await this.assertReadable()
		return await this.inbound.getInboundDeliveryWindow(input)
	}

	async claimInboundDeliveryWindow(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot> {
		await this.assertReadable()
		return await this.inbound.claimInboundDeliveryWindow(input)
	}

	async insertChargedPendingInboundDelivery(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.insertChargedPendingInboundDelivery(input)
	}

	async claimInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.claimInboundDeliveryStorage(input)
	}

	async releaseInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.releaseInboundDeliveryStorage(input)
	}

	async markInboundDeliveryRejected(input: {
		ownerId: string
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.markInboundDeliveryRejected(input)
	}

	async markInboundDeliveryReceived(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		usageDurationMs: number
		usageMonth: string
		usageBytes: number
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.markInboundDeliveryReceived(input)
	}

	async pruneExpiredInboundDedupePointers(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		await this.assertReadable()
		return await this.inbound.pruneExpiredInboundDedupePointers(input)
	}

	async deferInboundDeliveryReconciliation(input: {
		ownerId: string
		deliveryId: string
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.deferInboundDeliveryReconciliation(input)
	}

	async claimInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.claimInboundDeliveryCleanup(input)
	}

	async releaseInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.releaseInboundDeliveryCleanup(input)
	}

	async markInboundDeliveryOrphanCleaned(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.markInboundDeliveryOrphanCleaned(input)
	}

	async claimInboundUsageEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.claimInboundUsageEffect(input)
	}

	async completeInboundUsageEffect(input: {
		ownerId: string
		deliveryId: string
		usageEffectLease: string
		expectedFinalizationToken: string
		mode: 'recorded' | 'suppressed'
		usageMonth: string
		usageBytes: number
		usageDurationMs: number
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.completeInboundUsageEffect(input)
	}

	async claimInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.claimInboundSubscriptionEffect(input)
	}

	async completeInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		mode: 'complete' | 'suppressed'
		suppressionReason?: string | null
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.completeInboundSubscriptionEffect(input)
	}

	async failInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		error: string
		now?: string
	}) {
		await this.assertReadable()
		return await this.inbound.failInboundSubscriptionEffect(input)
	}

	async listDueStaleInboundDeliveries(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		await this.assertReadable()
		return await this.inbound.listDueStaleInboundDeliveries(input)
	}

	async listDueInboundEffectWork(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		await this.assertReadable()
		return await this.inbound.listDueInboundEffectWork(input)
	}

	async getInboundDueWorkHint(input: {
		ownerId: string
		now?: string
	}): Promise<{ dueAt: string | null }> {
		await this.assertReadable()
		return await this.inbound.getInboundDueWorkHint(input)
	}

	async purge(input: { ownerId: string }): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.store.assertOwner(input.ownerId)
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			await this.ctx.storage.deleteAll()
			this.maintenance.resetAfterPurge()
			await this.store.initializeSchema()
		})
		return { ok: true }
	}
}

export { MailboxService as Mailbox }

export type { MailboxRpc } from './mailbox-types.ts'
export {
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
	type MailboxCountResult,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRunRetentionNowResult,
	type MailboxRestoreStatus,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertMessageGraphInput,
} from './mailbox-types.ts'
export {
	computeMailboxRetentionReschedule,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-retention.ts'
export type MailboxNamespace = {
	forUser(userId: string): MailboxRpc
	maintain(userId: string): Promise<void>
}

export function createMailboxService(input: {
	forUser(userId: string): import('#worker/aws/pg-database.ts').PgDatabase
	env: Env
}): MailboxNamespace {
	return {
		async maintain(userId) {
			await (
				this.forUser(userId) as MailboxRpc & { alarm(): Promise<void> }
			).alarm()
		},
		forUser(userId) {
			assertMailboxNonEmptyString(userId, 'userId')
			return new Proxy({} as MailboxRpc, {
				get(_target, method: string) {
					if (
						typeof method !== 'string' ||
						!Object.hasOwn(MailboxService.prototype, method)
					)
						return undefined
					return async (...args: unknown[]) => {
						const ownerId = (args[0] as { ownerId?: string } | undefined)
							?.ownerId
						if (ownerId !== undefined && ownerId !== userId)
							throw new Error(
								'Mailbox ownerId mismatch; this mailbox is bound to a different owner.',
							)
						const result = await input
							.forUser(userId)
							.transaction(async (db) => {
								await db
									.prepare(
										`INSERT INTO kody_mailbox.mailbox_owner_identity (singleton,owner_id) VALUES (1,?) ON CONFLICT(user_id,singleton) DO NOTHING`,
									)
									.bind(userId)
									.run()
								// PostgreSQL row lock serializes one owner's graph/CAS operations across workers.
								await db
									.prepare(
										`SELECT owner_id FROM kody_mailbox.mailbox_owner_identity WHERE singleton = 1 FOR UPDATE`,
									)
									.all()
								const context = createMailboxContext(db)
								const service = new MailboxService(context, {
									...input.env,
									APP_DB: db as unknown as SqlDatabase,
								})
								const operation = service[method as keyof MailboxService]
								if (typeof operation !== 'function')
									throw new Error(`Unknown mailbox operation: ${method}`)
								const value = await (
									operation as (...args: unknown[]) => Promise<unknown>
								).apply(service, args)
								return { value, atMs: await context.storage.getAlarm() }
							})
						await scheduleMailboxMaintenance(input.env, userId, result.atMs)
						return result.value
					}
				},
			})
		},
	}
}
