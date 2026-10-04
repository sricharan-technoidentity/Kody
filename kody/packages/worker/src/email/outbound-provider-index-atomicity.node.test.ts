import { createTestDb } from '#worker/test-support/aws/test-db.ts'

import { expect, test } from 'vitest'

import {
	getOutboundProviderIndexRow,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'

test('thin provider index persists independently without a shared message graph table', async () => {
	await using database = await createTestDb({ userId: 'user-1' })
	const db = database.db

	await upsertOutboundProviderIndexRow({
		db,
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-1',
		now: '2026-08-03T00:00:00.000Z',
	})
	await upsertOutboundProviderIndexRow({
		db,
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-2',
		now: '2026-08-03T00:01:00.000Z',
	})

	await expect(
		getOutboundProviderIndexRow({
			db,
			providerMessageId: 'provider-1',
		}),
	).resolves.toEqual({
		provider: 'cloudflare-email',
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-2',
		createdAt: '2026-08-03T00:00:00.000Z',
		updatedAt: '2026-08-03T00:01:00.000Z',
	})
})
