import { type MailboxNamespace } from './mailbox-service.ts'
import { type MailboxRpc } from './mailbox-types.ts'
export type MailboxEnv = { MAILBOX_STORE?: MailboxNamespace }
export function mailboxNamespace(env: MailboxEnv): MailboxNamespace | null {
	return env.MAILBOX_STORE ?? null
}
export function mailboxRpc(input: {
	env: MailboxEnv
	userId: string
}): MailboxRpc {
	const service = mailboxNamespace(input.env)
	if (!service)
		throw new Error('MAILBOX_STORE Aurora service is not configured.')
	return service.forUser(input.userId)
}
export type { MailboxRpc }
