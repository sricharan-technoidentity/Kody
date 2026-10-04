import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { createFakeS3 } from '#worker/test-support/aws/fake-s3.ts'
import { createMailboxService } from './mailbox-service.ts'
import {
	baseMessage,
	baseThread,
	baseAttachment,
	baseDeliveryEvent,
} from './mailbox-test-helpers.ts'

test('Aurora mail preserves graphs, owner isolation, stale writes, dedupe and transactional rollback', async () => {
	const db = await createTestDb({ userId: 'mail-owner-a' })
	try {
		const service = createMailboxService({
			forUser: (id) => db.forUser(id).db,
			env: {
				EMAIL_BLOBS: createS3Objects({
					client: createFakeS3(),
					bucket: 'mail',
				}),
			} as Env,
		})
		const a = service.forUser('mail-owner-a')
		const b = service.forUser('mail-owner-b')
		const thread = baseThread({ id: 'same-thread' })
		const message = baseMessage('mail-owner-a', {
			id: 'same-message',
			threadId: thread.id,
			textBody: 'private body',
		})
		await a.upsertMessageGraph({
			ownerId: 'mail-owner-a',
			thread,
			message,
			attachments: [
				baseAttachment('mail-owner-a', message.id, { id: 'same-attachment' }),
			],
		})
		expect(await b.getMessage({ messageId: message.id })).toBeNull()
		await b.upsertMessageGraph({
			ownerId: 'mail-owner-b',
			message: baseMessage('mail-owner-b', { id: message.id }),
		})
		expect((await a.getMessage({ messageId: message.id }))?.textBody).toBe(
			'private body',
		)
		expect((await a.listMessages({})).messages[0]?.textBody).toBeNull()
		expect((await a.searchMessages({ query: 'hello' })).messages).toHaveLength(
			1,
		)
		await expect(
			a.upsertMessageGraph({ ownerId: 'mail-owner-b', message }),
		).rejects.toThrow(/ownerId mismatch/)
		expect(
			await a.upsertMessageGraph({
				ownerId: 'mail-owner-a',
				message: { ...message, updatedAt: '2026-06-01T12:00:00.000Z' },
			}),
		).toMatchObject({ accepted: false })
		const event = baseDeliveryEvent({
			id: 'event',
			messageId: message.id,
			providerEventId: 'same-provider-event',
		})
		expect(
			await a.upsertDeliveryEvent({ ownerId: 'mail-owner-a', event }),
		).toMatchObject({ inserted: true })
		expect(
			await a.upsertDeliveryEvent({
				ownerId: 'mail-owner-a',
				event: { ...event, id: 'duplicate' },
			}),
		).toMatchObject({ inserted: false, accepted: false })
		const before = await a.countMailbox()
		await expect(
			a.upsertDeliveryEvents({
				ownerId: 'mail-owner-a',
				events: [
					baseDeliveryEvent({ id: 'rollback' }),
					baseDeliveryEvent({ id: 'invalid', createdAt: 'bad' }),
				],
			}),
		).rejects.toThrow(/canonical ISO/)
		expect(await a.countMailbox()).toEqual(before)
		const exported = await a.exportMailbox({ pageSize: 100 })
		expect(exported.rows.map((row) => row.kind)).toEqual(
			expect.arrayContaining([
				'thread',
				'message',
				'attachment',
				'delivery_event',
			]),
		)
		await a.deleteMessageMetadata({
			ownerId: 'mail-owner-a',
			messageId: message.id,
			deletedAt: '2026-08-01T12:00:00.000Z',
		})
		expect(
			await a.upsertMessageGraph({ ownerId: 'mail-owner-a', message }),
		).toMatchObject({ accepted: false })
		expect(await b.getMessage({ messageId: message.id })).not.toBeNull()
	} finally {
		await db.pg.close()
	}
})
