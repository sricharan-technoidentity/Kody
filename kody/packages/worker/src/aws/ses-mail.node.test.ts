import { expect, test } from 'vitest'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createSesMail } from './ses-mail.ts'

test('SES sends validated mail with UTF-8 bodies, headers and binary attachments and requires acceptance id', async () => {
	const commands: SendEmailCommand[] = []
	const mail = createSesMail({
		region: 'us-east-1',
		async send(command) {
			commands.push(command)
			return { $metadata: {}, MessageId: 'accepted-id' }
		},
	})
	expect(
		await mail.send({
			from: 'sender@kody.test',
			to: ['recipient@example.test'],
			subject: 'Hello',
			html: '<b>Hello</b>',
			text: 'Hello',
			replyTo: 'reply@kody.test',
			headers: { 'X-Test': 'yes' },
			attachments: [
				{
					filename: 'a.txt',
					type: 'text/plain',
					content: 'aGVsbG8=',
					disposition: 'attachment',
				},
			],
		}),
	).toEqual({ messageId: 'accepted-id' })
	expect(commands[0]).toBeInstanceOf(SendEmailCommand)
	expect(commands[0]!.input).toMatchObject({
		FromEmailAddress: 'sender@kody.test',
		Destination: { ToAddresses: ['recipient@example.test'] },
		ReplyToAddresses: ['reply@kody.test'],
		Content: {
			Simple: {
				Subject: { Data: 'Hello', Charset: 'UTF-8' },
				Body: { Text: { Data: 'Hello' }, Html: { Data: '<b>Hello</b>' } },
				Headers: [{ Name: 'X-Test', Value: 'yes' }],
				Attachments: [
					{
						RawContent: Buffer.from('hello'),
						FileName: 'a.txt',
						ContentDisposition: 'ATTACHMENT',
						ContentTransferEncoding: 'BASE64',
					},
				],
			},
		},
	})
	await expect(
		mail.send({ from: '', to: 'r', subject: 's', html: 'h' }),
	).rejects.toThrow('Invalid outbound')
	expect(commands).toHaveLength(1)
	const incomplete = createSesMail({
		region: 'us-east-1',
		async send() {
			return { $metadata: {} }
		},
	})
	await expect(
		incomplete.send({ from: 's', to: 'r', subject: 's', html: 'h' }),
	).rejects.toThrow('without a message id')
})
