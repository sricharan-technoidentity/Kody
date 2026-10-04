import {
	SESv2Client,
	SendEmailCommand,
	type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2'
import { Buffer } from 'node:buffer'
import { type SesMail, validateOutboundMail } from '#worker/email/ses.ts'

export function createSesMail(input: {
	region: string
	send?: (command: SendEmailCommand) => Promise<SendEmailCommandOutput>
}): SesMail {
	const client = input.send ? null : new SESv2Client({ region: input.region })
	const send =
		input.send ?? ((command: SendEmailCommand) => client!.send(command))
	return {
		async send(message) {
			// The same validation protects direct provider callers and the mail service.
			const parsed = validateOutboundMail(message)
			const content = (Data: string) => ({ Data, Charset: 'UTF-8' })
			const response = await send(
				new SendEmailCommand({
					FromEmailAddress: parsed.from,
					Destination: {
						ToAddresses: Array.isArray(parsed.to) ? parsed.to : [parsed.to],
					},
					ReplyToAddresses: parsed.replyTo ? [parsed.replyTo] : undefined,
					Content: {
						Simple: {
							Subject: content(parsed.subject),
							Body: {
								Html: content(parsed.html),
								Text: parsed.text ? content(parsed.text) : undefined,
							},
							Headers: parsed.headers
								? Object.entries(parsed.headers).map(([Name, Value]) => ({
										Name,
										Value,
									}))
								: undefined,
							Attachments: parsed.attachments?.map((a) => ({
								RawContent: Buffer.from(a.content, 'base64'),
								FileName: a.filename,
								ContentType: a.type,
								ContentDisposition:
									a.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT',
								ContentId: a.contentId,
								ContentTransferEncoding: 'BASE64',
							})),
						},
					},
				}),
			)
			if (!response.MessageId?.trim())
				throw new Error('SES accepted the send without a message id.')
			return { messageId: response.MessageId }
		},
	}
}
