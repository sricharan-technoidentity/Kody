import { type MailboxContext } from './mailbox-sql.ts'
import {
	claimMailboxInboundDeliveryCleanup,
	markMailboxInboundDeliveryOrphanCleaned,
	releaseMailboxInboundDeliveryCleanup,
} from './mailbox-inbound-cleanup-ledger.ts'
import {
	claimMailboxInboundSubscriptionEffect,
	claimMailboxInboundUsageEffect,
	completeMailboxInboundSubscriptionEffect,
	completeMailboxInboundUsageEffect,
	failMailboxInboundSubscriptionEffect,
	listMailboxDueInboundEffectWork,
} from './mailbox-inbound-effect-ledger.ts'
import {
	claimMailboxInboundDeliveryStorage,
	claimMailboxInboundDeliveryWindow,
	deferMailboxInboundDeliveryReconciliation,
	getMailboxInboundDelivery,
	getMailboxInboundDeliveryWindow,
	insertMailboxChargedPendingInboundDelivery,
	listMailboxDueStaleInboundDeliveries,
	markMailboxInboundDeliveryReceived,
	markMailboxInboundDeliveryRejected,
	pruneMailboxExpiredInboundDedupePointers,
	releaseMailboxInboundDeliveryStorage,
} from './mailbox-inbound-ledger.ts'
import { getMailboxInboundDueAt } from './inbound-due-owners.ts'
import { type MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import { type MailboxStore } from './mailbox-store.ts'
import { type MailboxRpc } from './mailbox-types.ts'

export class MailboxInboundCommands {
	private readonly ctx: MailboxContext
	private readonly store: MailboxStore
	private readonly maintenance: MailboxMaintenanceCommands

	constructor(
		ctx: MailboxContext,
		store: MailboxStore,
		maintenance: MailboxMaintenanceCommands,
	) {
		this.ctx = ctx
		this.store = store
		this.maintenance = maintenance
	}

	async getInboundDelivery(
		input: Parameters<MailboxRpc['getInboundDelivery']>[0],
	) {
		await this.store.assertOwner(input.ownerId)
		return await getMailboxInboundDelivery(
			this.ctx.storage.sql,
			input.deliveryId,
		)
	}

	async getInboundDeliveryWindow(
		input: Parameters<MailboxRpc['getInboundDeliveryWindow']>[0],
	) {
		await this.store.assertOwner(input.ownerId)
		return await getMailboxInboundDeliveryWindow(this.ctx.storage.sql, input)
	}

	async claimInboundDeliveryWindow(
		input: Parameters<MailboxRpc['claimInboundDeliveryWindow']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryWindow']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await claimMailboxInboundDeliveryWindow(
				this.ctx.storage.sql,
				input,
			)
		})
		await this.maintenance.markDirtyAndEnsure()
		return result
	}

	async insertChargedPendingInboundDelivery(
		input: Parameters<MailboxRpc['insertChargedPendingInboundDelivery']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['insertChargedPendingInboundDelivery']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await insertMailboxChargedPendingInboundDelivery(
				this.ctx.storage.sql,
				input,
			)
		})
		await this.maintenance.markDirtyAndEnsure()
		return result
	}

	async claimInboundDeliveryStorage(
		input: Parameters<MailboxRpc['claimInboundDeliveryStorage']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryStorage']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await claimMailboxInboundDeliveryStorage(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'claimed') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async releaseInboundDeliveryStorage(
		input: Parameters<MailboxRpc['releaseInboundDeliveryStorage']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryStorage']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await releaseMailboxInboundDeliveryStorage(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'released') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async markInboundDeliveryRejected(
		input: Parameters<MailboxRpc['markInboundDeliveryRejected']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryRejected']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await markMailboxInboundDeliveryRejected(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'rejected') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async markInboundDeliveryReceived(
		input: Parameters<MailboxRpc['markInboundDeliveryReceived']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryReceived']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await markMailboxInboundDeliveryReceived(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'received') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async pruneExpiredInboundDedupePointers(
		input: Parameters<MailboxRpc['pruneExpiredInboundDedupePointers']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['pruneExpiredInboundDedupePointers']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await pruneMailboxExpiredInboundDedupePointers(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.pruned > 0) {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async deferInboundDeliveryReconciliation(
		input: Parameters<MailboxRpc['deferInboundDeliveryReconciliation']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['deferInboundDeliveryReconciliation']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await deferMailboxInboundDeliveryReconciliation(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'deferred') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async claimInboundDeliveryCleanup(
		input: Parameters<MailboxRpc['claimInboundDeliveryCleanup']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryCleanup']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await claimMailboxInboundDeliveryCleanup(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async releaseInboundDeliveryCleanup(
		input: Parameters<MailboxRpc['releaseInboundDeliveryCleanup']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryCleanup']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await releaseMailboxInboundDeliveryCleanup(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async markInboundDeliveryOrphanCleaned(
		input: Parameters<MailboxRpc['markInboundDeliveryOrphanCleaned']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['markInboundDeliveryOrphanCleaned']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await markMailboxInboundDeliveryOrphanCleaned(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async claimInboundUsageEffect(
		input: Parameters<MailboxRpc['claimInboundUsageEffect']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundUsageEffect']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await claimMailboxInboundUsageEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	async completeInboundUsageEffect(
		input: Parameters<MailboxRpc['completeInboundUsageEffect']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['completeInboundUsageEffect']>>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await completeMailboxInboundUsageEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async claimInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['claimInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['claimInboundSubscriptionEffect']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await claimMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async completeInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['completeInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['completeInboundSubscriptionEffect']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await completeMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async failInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['failInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['failInboundSubscriptionEffect']>
		>
		await this.ctx.storage.transaction(async () => {
			await this.store.assertOwner(input.ownerId)
			result = await failMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async listDueStaleInboundDeliveries(
		input: Parameters<MailboxRpc['listDueStaleInboundDeliveries']>[0],
	) {
		await this.store.assertOwner(input.ownerId)
		return await listMailboxDueStaleInboundDeliveries(
			this.ctx.storage.sql,
			input,
		)
	}

	async listDueInboundEffectWork(
		input: Parameters<MailboxRpc['listDueInboundEffectWork']>[0],
	) {
		await this.store.assertOwner(input.ownerId)
		return await listMailboxDueInboundEffectWork(this.ctx.storage.sql, input)
	}

	async getInboundDueWorkHint(
		input: Parameters<MailboxRpc['getInboundDueWorkHint']>[0],
	) {
		await this.store.assertOwner(input.ownerId)
		let now: Date | undefined
		if (input.now != null) {
			const parsed = Date.parse(input.now)
			if (Number.isFinite(parsed)) now = new Date(parsed)
		}
		return {
			dueAt: await getMailboxInboundDueAt(this.ctx.storage.sql, now),
		}
	}
}
