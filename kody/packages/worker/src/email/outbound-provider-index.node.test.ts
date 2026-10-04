import { env } from '#worker/test-support/mail.ts'
import { expect } from 'vitest'
import { test } from '#worker/test-support/mail.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	deleteOutboundProviderIndexByMessageId,
	getOutboundProviderIndexRow,
	loadOutboundProviderIndexHealthReport,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('thin provider index persists after the USER graph is removed', async () => {
	const userId = `index-user-${crypto.randomUUID()}`
	const messageId = `index-message-${crypto.randomUUID()}`
	const providerMessageId = `index-provider-${crypto.randomUUID()}`
	const now = '2026-08-03T02:00:00.000Z'

	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId,
		inboxId: null,
		now,
	})
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toMatchObject({ userId, messageId, providerMessageId })
	expect(
		await loadOutboundProviderIndexHealthReport({ db: env.APP_DB }),
	).toMatchObject({
		healthy: true,
		malformedCount: 0,
	})

	const legacyTables = await env.APP_DB.prepare(
		`SELECT table_name AS name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN (
			'email_threads', 'email_messages', 'email_attachments',
			'email_delivery_events'
		)`,
	).all()
	expect(legacyTables.results).toEqual([])

	await deleteOutboundProviderIndexByMessageId({
		db: env.APP_DB,
		messageId,
	})
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toBeNull()
})

test('provider index rejects the dedicated system owner', async () => {
	await expect(
		upsertOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId: `system-provider-${crypto.randomUUID()}`,
			userId: systemEmailOwnerId,
			messageId: `system-message-${crypto.randomUUID()}`,
			inboxId: null,
			now: new Date().toISOString(),
		}),
	).rejects.toThrow(/check constraint/)
})
