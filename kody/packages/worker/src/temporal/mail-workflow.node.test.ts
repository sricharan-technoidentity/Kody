import { expect } from 'vitest'
import { test, env } from '#worker/test-support/mail.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import {
	baseMessage,
	baseDeliveryEvent,
} from '#worker/email/mailbox-test-helpers.ts'
import { upsertOutboundProviderIndexRow } from '#worker/email/outbound-provider-index.ts'
import { createMailActivities } from './mail-activities.ts'

test('Temporal delivery processing records SES complaint, pauses once across replay and runs mailbox maintenance', async () => {
	const actualEnv = { ...env }
	const userId = 'mail-workflow-owner'
	const at = new Date().toISOString()
	await actualEnv.APP_DB.prepare(
		'INSERT INTO users(username,email,password_hash,stable_user_id,plan,email_verified_at) VALUES (?,?,?,?,?,?)',
	)
		.bind(userId, 'mail-owner@example.test', 'mock', userId, 'max', at)
		.run()
	const mailbox = actualEnv.MAILBOX_STORE!.forUser(userId)
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: baseMessage(userId, {
			id: 'message',
			direction: 'outbound',
			providerMessageId: 'ses-message',
			createdAt: at,
			updatedAt: at,
		}),
	})
	await upsertOutboundProviderIndexRow({
		db: actualEnv.APP_DB,
		userId,
		messageId: 'message',
		providerMessageId: 'ses-message',
		inboxId: null,
		now: at,
	})
	const temporal = await createTemporalEnv()
	try {
		const activity = createMailActivities({
			env: actualEnv,
			forUser: (id) => ({
				...actualEnv,
				APP_DB: actualEnv.APP_DB_FOR_USER!(id),
			}),
		})
		await temporal.startWorkers({ queues: ['platform'], activities: activity })
		const body = {
			notificationType: 'Complaint',
			mail: {
				messageId: 'ses-message',
				timestamp: at,
				source: 'sender@kody.test',
				destination: ['recipient@example.test'],
			},
			complaint: { timestamp: at, feedbackId: 'complaint' },
		}
		for (const workflowId of ['delivery-one', 'delivery-replay']) {
			await temporal.client.workflow.execute('DeliveryEvents', {
				workflowId,
				taskQueue: 'platform',
				args: [{ body }],
			})
		}
		expect(
			(await mailbox.listDeliveryEvents({})).filter(
				(e) => e.eventType === 'complained',
			),
		).toHaveLength(1)
		expect(
			await actualEnv.APP_DB.prepare(
				'SELECT email_outbound_paused_at FROM users WHERE stable_user_id=?',
			)
				.bind(userId)
				.first(),
		).toEqual({ email_outbound_paused_at: at })
		await mailbox.upsertDeliveryEvent({
			ownerId: userId,
			event: baseDeliveryEvent({
				id: 'expired',
				eventType: 'sent',
				createdAt: '2020-01-01T00:00:00.000Z',
				updatedAt: '2020-01-01T00:00:00.000Z',
			}),
		})
		await temporal.client.workflow.execute('MailboxMaintenance', {
			workflowId: 'mail-maintenance',
			taskQueue: 'platform',
			args: [{ userId }],
		})
		expect(
			(await mailbox.listDeliveryEvents({})).some((e) => e.id === 'expired'),
		).toBe(false)
	} finally {
		await temporal.close()
	}
}, 60000)
