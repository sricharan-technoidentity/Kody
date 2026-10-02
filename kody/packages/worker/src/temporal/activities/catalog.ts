import { ApplicationFailure } from '@temporalio/common'
import { emailRawMimeKey } from '#worker/email/blob-keys.ts'
import { resolveInboundMailboxRoute } from '#worker/email/inbound-mailbox-route.ts'
import {
	getAcceptedUserEmailDomains,
	getAcceptedSystemEmailDomains,
	getSystemEmailDomain,
} from '#worker/email/platform-address.ts'
import { maxSurvivableInboundRawBytes } from '#worker/email/skinny-inbound-mime.ts'
import { type EmailSendInput } from '#worker/email/outbound.ts'
import {
	type CatalogActivities,
	type MailObjectInput,
} from './catalog-types.ts'

/** Draft bodies/attachments are stored outside Temporal history. */
export function outboundEmailDraftKey(userId: string, messageId: string) {
	return `email-send:v1:${userId}/${messageId}`
}

function invalid(message: string): never {
	throw ApplicationFailure.nonRetryable(message, 'InvalidCatalogInput')
}

/**
 * P5 moves orchestration around the existing domain services. P6 replaces
 * the Mailbox/MCP backend behind these services; P7 supplies scoped envs.
 */
export function createAppCatalogActivities(input: {
	forUser(userId: string): Promise<Env>
}) {
	async function ownedEnv(userId: string) {
		const env = await input.forUser(userId)
		const user = await env.APP_DB.prepare(
			'SELECT id, username, email FROM users WHERE stable_user_id = ?',
		)
			.bind(userId)
			.first<{ id: number; username: string; email: string }>()
		if (!user) invalid('Account does not exist in the subject environment.')
		return { env, user }
	}
	async function readObject(
		env: Env,
		mail: MailObjectInput,
		expectedKey: string,
	) {
		if (mail.objectKey !== expectedKey)
			invalid('Mail object does not belong to this message and owner.')
		const object = await env.EMAIL_BLOBS.get(mail.objectKey)
		if (!object) invalid('Mail object was not found.')
		return new Uint8Array(await object.arrayBuffer())
	}
	return {
		async deleteAccount(account) {
			const { env, user } = await ownedEnv(account.userId)
			if (Number(user.id) !== account.dbUserId)
				invalid('Account deletion owner mismatch.')
			const { deleteUserAccount } = await import('#app/account-deletion.ts')
			return deleteUserAccount({
				env,
				dbUserId: account.dbUserId,
				mcpUserId: account.userId,
			})
		},
		async receiveEmail(mail) {
			const { env, user } = await ownedEnv(mail.userId)
			const bytes = await readObject(
				env,
				mail,
				emailRawMimeKey(mail.userId, mail.messageId),
			)
			const route = resolveInboundMailboxRoute({
				envelopeTo: mail.to,
				acceptedUserDomains: getAcceptedUserEmailDomains(env),
				acceptedSystemDomains: getAcceptedSystemEmailDomains(env),
				systemDomain: getSystemEmailDomain(env),
			})
			if (
				route.kind !== 'user' ||
				route.username !== user.username.toLowerCase()
			)
				invalid('Inbound recipient does not belong to the workflow owner.')
			if (bytes.byteLength > maxSurvivableInboundRawBytes) {
				return { rejected: 'Inbound email exceeds the raw message size limit.' }
			}
			const { default: PostalMime } = await import('postal-mime')
			const parsed = await PostalMime.parse(bytes)
			const headers = new Headers()
			for (const header of parsed.headers)
				headers.append(header.originalKey || header.key, header.value)
			let rejected: string | null = null
			const message: ForwardableEmailMessage = {
				from: mail.from,
				to: mail.to,
				headers,
				rawSize: bytes.byteLength,
				raw: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes)
						controller.close()
					},
				}),
				setReject(reason) {
					rejected = reason
				},
				async forward() {
					invalid('Inbound forwarding is unsupported in the POC.')
				},
				async reply() {
					invalid('Inbound replies use OutboundEmail.')
				},
			}
			const { handleInboundEmail } = await import('#worker/email/inbound.ts')
			await handleInboundEmail(message, env)
			return { rejected }
		},
		async sendEmail(mail) {
			const { env, user } = await ownedEnv(mail.userId)
			const bytes = await readObject(
				env,
				mail,
				outboundEmailDraftKey(mail.userId, mail.messageId),
			)
			let draft: Omit<EmailSendInput, 'env' | 'userId'>
			try {
				draft = JSON.parse(new TextDecoder().decode(bytes)) as typeof draft
			} catch {
				invalid('Invalid outbound email draft.')
			}
			if (
				!draft ||
				typeof draft.accountEmail !== 'string' ||
				typeof draft.subject !== 'string' ||
				(draft.recipientPolicy !== 'self' && draft.recipientPolicy !== 'reply')
			)
				invalid('Invalid outbound email draft.')
			const { sendOutboundEmail } = await import('#worker/email/outbound.ts')
			const result = await sendOutboundEmail({
				...draft,
				env,
				userId: mail.userId,
				accountEmail: user.email,
			} as EmailSendInput)
			return { messageId: result.message.id, status: result.status }
		},
		async maintainMcpConnection(connection) {
			const { env } = await ownedEnv(connection.userId)
			const { createMcpClientHubClient } =
				await import('#worker/mcp-client/hub-client.ts')
			const client = createMcpClientHubClient({
				env,
				userId: connection.userId,
			})
			let result = await client.refreshServer({ serverId: connection.serverId })
			if (result.state === 'failed' || result.state === 'disconnected') {
				result = await client.reconnectServer({
					serverId: connection.serverId,
					callbackUrl: connection.callbackUrl,
				})
			}
			return {
				connected: result.state === 'ready' || result.state === 'connected',
			}
		},
		async disconnectMcpConnection(connection) {
			const { env } = await ownedEnv(connection.userId)
			const { createMcpClientHubClient } =
				await import('#worker/mcp-client/hub-client.ts')
			await createMcpClientHubClient({
				env,
				userId: connection.userId,
			}).removeServer({ serverId: connection.serverId })
		},
	} satisfies CatalogActivities
}
