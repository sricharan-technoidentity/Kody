import { parseSafe } from 'remix/data-schema'
import {
	type OutboundEmail,
	outboundEmailSchema,
} from '@kody-internal/shared/outbound-email.ts'
export type SesMail = {
	send(message: OutboundEmail): Promise<{ messageId: string }>
}
export function validateOutboundMail(message: unknown) {
	const parsed = parseSafe(outboundEmailSchema, message)
	if (!parsed.success) throw new Error('Invalid outbound mail payload.')
	return parsed.value
}
/** Validate at the provider boundary; SES acceptance id is the terminal send marker. */
export async function sendSesEmail(
	env: { SES_MAIL?: SesMail },
	message: OutboundEmail,
) {
	if (!env.SES_MAIL) throw new Error('SES mail service is not configured.')
	const mail = validateOutboundMail(message)
	const result = await env.SES_MAIL.send(mail)
	if (!result.messageId?.trim())
		throw new Error('SES accepted the send without a message id.')
	return { ok: true as const, messageId: result.messageId }
}
