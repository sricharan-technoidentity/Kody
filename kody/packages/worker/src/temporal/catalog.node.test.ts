import { expect, test, vi } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import {
	createAppCatalogActivities,
	outboundEmailDraftKey,
} from './activities/catalog.ts'
import { type CatalogActivities } from './activities/catalog-types.ts'
import {
	startAccountDelete,
	startInboundEmail,
	startMcpServerConnection,
	startOutboundEmail,
	signalMcpServerConnection,
} from './catalog.ts'

const delegatedMail = vi.hoisted(() => ({
	inbound: [] as Array<{ raw: string; headers: Headers }>,
	outbound: [] as Array<Record<string, unknown>>,
}))
vi.mock('#worker/email/inbound.ts', () => ({
	async handleInboundEmail(message: ForwardableEmailMessage) {
		delegatedMail.inbound.push({
			raw: await new Response(message.raw).text(),
			headers: message.headers,
		})
	},
}))
vi.mock('#worker/email/outbound.ts', () => ({
	async sendOutboundEmail(input: Record<string, unknown>) {
		delegatedMail.outbound.push(input)
		return { message: { id: 'persisted-outbound-id' }, status: 'sent' }
	},
}))

test('catalog starts dedupe owner-scoped deletion and mail, retry inbound, and do not replay accepted outbound sends', async () => {
	const temporal = await createTemporalEnv()
	try {
		let receives = 0
		let sends = 0
		let deletes = 0
		const inputs: unknown[] = []
		await temporal.startWorkers({
			queues: ['app', 'platform'],
			activities: {
				async deleteAccount(input) {
					deletes += 1
					inputs.push(input)
					return { deleted: true }
				},
				async receiveEmail(input) {
					inputs.push(input)
					receives += 1
					if (receives === 1) throw new Error('temporary object read failure')
					return { rejected: null }
				},
				async sendEmail(input) {
					inputs.push(input)
					sends += 1
					if (input.messageId === 'uncertain')
						throw new Error('accepted, response lost')
					return { messageId: input.messageId, status: 'sent' }
				},
			} satisfies Partial<CatalogActivities>,
		})
		const account = { userId: 'alice', dbUserId: 1 }
		expect(await startAccountDelete(temporal.temporal, account)).toBe('started')
		expect(
			await temporal.client.workflow.getHandle('alice:delete').result(),
		).toEqual({ deleted: true })
		expect(await startAccountDelete(temporal.temporal, account)).toBe(
			'duplicate',
		)
		const inbound = {
			userId: 'alice',
			messageId: 'in',
			objectKey: 'email-raw:v1:alice/in',
			from: 'sender@example.com',
			to: 'alice@inbox.kody.test',
		}
		await startInboundEmail(temporal.temporal, inbound)
		expect(
			await temporal.client.workflow.getHandle('alice:mail:in').result(),
		).toEqual({ rejected: null })
		await startOutboundEmail(temporal.temporal, {
			userId: 'alice',
			messageId: 'out',
			objectKey: outboundEmailDraftKey('alice', 'out'),
		})
		expect(
			await temporal.client.workflow.getHandle('alice:mail:out').result(),
		).toEqual({ messageId: 'out', status: 'sent' })
		expect(
			await startOutboundEmail(temporal.temporal, {
				userId: 'alice',
				messageId: 'out',
				objectKey: outboundEmailDraftKey('alice', 'out'),
			}),
		).toBe('duplicate')
		await startOutboundEmail(temporal.temporal, {
			userId: 'alice',
			messageId: 'uncertain',
			objectKey: outboundEmailDraftKey('alice', 'uncertain'),
		})
		await expect(
			temporal.client.workflow.getHandle('alice:mail:uncertain').result(),
		).rejects.toThrow('Workflow execution failed')
		expect({ receives, sends, deletes }).toEqual({
			receives: 2,
			sends: 2,
			deletes: 1,
		})
		// Neither raw MIME, body nor attachment bytes enter workflow/activity input history.
		expect(inputs).toEqual([
			account,
			inbound,
			inbound,
			{
				userId: 'alice',
				messageId: 'out',
				objectKey: 'email-send:v1:alice/out',
			},
			{
				userId: 'alice',
				messageId: 'uncertain',
				objectKey: 'email-send:v1:alice/uncertain',
			},
		])
	} finally {
		await temporal.close()
	}
})

test('MCP entity keeps backoff through Continue-As-New and remove interrupts its wait', async () => {
	const temporal = await createTemporalEnv()
	try {
		let attempts = 0
		const removed: string[] = []
		const carriedFailures: number[] = []
		await temporal.startWorkers({
			queues: ['platform'],
			activities: {
				async maintainMcpConnection(input) {
					carriedFailures.push((input as { failures?: number }).failures ?? 0)
					attempts += 1
					return { connected: attempts > 1 }
				},
				async disconnectMcpConnection(input) {
					removed.push(`${input.userId}:${input.serverId}`)
				},
			} satisfies Partial<CatalogActivities>,
		})
		const input = {
			userId: 'alice',
			serverId: 'remote',
			callbackUrl: 'https://kody.test/callback',
			stepsPerRun: 1,
		}
		const handle = await startMcpServerConnection(temporal.temporal, input)
		const deadline = Date.now() + 10_000
		while (attempts < 2) {
			if (Date.now() > deadline)
				throw new Error('entity did not continue as new')
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		expect(carriedFailures.slice(0, 2)).toEqual([0, 1])
		await signalMcpServerConnection(temporal.temporal, {
			...input,
			command: 'remove',
		})
		await handle.result()
		expect(removed).toEqual(['alice:remote'])
	} finally {
		await temporal.close()
	}
})

test('catalog activities reject forged account ids and cross-owner mail references before reading any object', async () => {
	let reads = 0
	const owners: string[] = []
	const activities = createAppCatalogActivities({
		async forUser(userId) {
			owners.push(userId)
			return {
				APP_DB: {
					prepare() {
						return {
							bind() {
								return {
									async first() {
										return { id: 1 }
									},
								}
							},
						}
					},
				},
				EMAIL_BLOBS: {
					async get() {
						reads += 1
						return null
					},
				},
			} as unknown as Env
		},
	})
	await expect(
		activities.deleteAccount({ userId: 'alice', dbUserId: 2 }),
	).rejects.toThrow('owner mismatch')
	await expect(
		activities.receiveEmail({
			userId: 'alice',
			messageId: 'one',
			objectKey: 'email-raw:v1:bob/one',
			from: 'sender@example.com',
			to: 'alice@example.com',
		}),
	).rejects.toThrow('does not belong')
	await expect(
		activities.sendEmail({
			userId: 'alice',
			messageId: 'one',
			objectKey: 'email-send:v1:bob/one',
		}),
	).rejects.toThrow('does not belong')
	await expect(
		activities.receiveEmail({
			userId: 'alice',
			messageId: 'one',
			objectKey: 'email-raw:v1:alice/one',
			from: 'sender@example.com',
			to: 'alice@example.com',
		}),
	).rejects.toThrow('not found')
	expect(reads).toBe(1)
	expect(owners).toEqual(['alice', 'alice', 'alice', 'alice'])
})

test('mail activities load object bytes and preserve existing service inputs while pinning recipient/account identity', async () => {
	const raw =
		'From: sender@example.com\r\nTo: alice@inbox.kody.test\r\nSubject: Hello\r\nAuthentication-Results: ses.example; spf=pass\r\n\r\nBody'
	const objects = new Map([
		['email-raw:v1:alice/in', raw],
		[
			'email-send:v1:alice/out',
			JSON.stringify({
				accountEmail: 'forged@example.com',
				subject: 'Reply',
				text: 'Body',
				recipientPolicy: 'self',
			}),
		],
	])
	const env = {
		APP_BASE_URL: 'https://kody.test',
		APP_DB: {
			prepare() {
				return {
					bind() {
						return {
							async first() {
								return { id: 1, username: 'alice', email: 'alice@example.com' }
							},
						}
					},
				}
			},
		},
		EMAIL_BLOBS: {
			async get(key: string) {
				const body = objects.get(key)
				return body === undefined
					? null
					: {
							async arrayBuffer() {
								return new TextEncoder().encode(body).buffer
							},
						}
			},
		},
	} as unknown as Env
	const activities = createAppCatalogActivities({ forUser: async () => env })
	expect(
		await activities.receiveEmail({
			userId: 'alice',
			messageId: 'in',
			objectKey: 'email-raw:v1:alice/in',
			from: 'sender@example.com',
			to: 'alice@inbox.kody.test',
		}),
	).toEqual({ rejected: null })
	expect(delegatedMail.inbound[0]?.raw).toBe(raw)
	expect(delegatedMail.inbound[0]?.headers.get('Authentication-Results')).toBe(
		'ses.example; spf=pass',
	)
	await expect(
		activities.receiveEmail({
			userId: 'alice',
			messageId: 'in',
			objectKey: 'email-raw:v1:alice/in',
			from: 'sender@example.com',
			to: 'bob@inbox.kody.test',
		}),
	).rejects.toThrow('recipient does not belong')
	expect(
		await activities.sendEmail({
			userId: 'alice',
			messageId: 'out',
			objectKey: 'email-send:v1:alice/out',
		}),
	).toEqual({ messageId: 'persisted-outbound-id', status: 'sent' })
	expect(delegatedMail.outbound[0]).toMatchObject({
		userId: 'alice',
		accountEmail: 'alice@example.com',
		subject: 'Reply',
		text: 'Body',
		recipientPolicy: 'self',
	})
})
