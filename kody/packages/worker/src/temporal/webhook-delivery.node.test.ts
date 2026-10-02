import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { deliverWebhook } from './webhook-delivery.ts'

test('webhook verifies HMAC and replay before one ack or sync workflow', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		env.runner.respondWith({ output: 'handled' })
		const body = '{"value":1}'
		const signature = createHmac('sha256', 'secret').update(body).digest('hex')
		const request = (timestamp = Math.floor(Date.now() / 1_000)) =>
			new Request('https://alice.kody.run/hook', {
				method: 'POST',
				body,
				headers: {
					'x-kody-signature': signature,
					'x-kody-timestamp': String(timestamp),
				},
			})
		const input = {
			env,
			userId: 'alice',
			endpointId: 'endpoint',
			deliveryId: 'delivery',
			mode: 'ack' as const,
			request: request(),
			webhookSecret: 'secret',
			replayToleranceSeconds: 300,
			rateLimitPerMinute: 1,
		}
		const ack = await deliverWebhook(input)
		expect(ack).toMatchObject({ status: 202, workflowId: 'endpoint:delivery' })
		expect(
			await deliverWebhook({ ...input, request: request() }),
		).toMatchObject({ workflowId: ack.workflowId })
		const sync = await deliverWebhook({
			...input,
			mode: 'sync',
			request: request(),
		})
		expect(sync.status).toBe(200)
		expect(sync.result).toMatchObject({ ok: true, output: 'handled' })
		expect(env.runner.invocations).toHaveLength(1)
		await expect(
			deliverWebhook({
				...input,
				deliveryId: 'bad',
				request: new Request('https://alice.kody.run/hook', {
					method: 'POST',
					body,
					headers: { 'x-kody-signature': 'invalid' },
				}),
			}),
		).rejects.toThrow('signature')
		await expect(
			deliverWebhook({ ...input, deliveryId: 'stale', request: request(1) }),
		).rejects.toThrow('replay')
		expect(
			await deliverWebhook({
				...input,
				deliveryId: 'delivery-2',
				request: request(),
			}),
		).toMatchObject({ status: 429 })
	} finally {
		await close()
	}
})
