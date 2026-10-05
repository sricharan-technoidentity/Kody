import { expect, test } from 'vitest'
import getPort from 'get-port'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { createFakeS3 } from '#worker/test-support/aws/fake-s3.ts'
import { createAgentCoreRunner } from '#worker/aws/agentcore-runner.ts'
import { startRunnerHost } from './runner-host.ts'
import { proveRuntime } from './aws-runtime.ts'
import { PendingProof } from './aws-config.ts'

test.each(['success', 'lost-response', 'unavailable-runtime'])(
	'integrated proof uses real Temporal, SDK reference transport, signed broker and Deno with %s; cleans only proof-owned state',
	{ timeout: 60000 },
	async (scenario) => {
		const port = await getPort({ host: '127.0.0.1' })
		const fake = createFakeS3()
		const writes: Array<string> = []
		const objects = createS3Objects({
			region: 'us-east-1',
			bucket: 'proof',
			async send(command) {
				if (command instanceof PutObjectCommand) writes.push(command.input.Key!)
				return fake.send(command)
			},
		})
		await objects.put('keep-existing-object', 'unchanged')
		const host = await startRunnerHost({
			brokerUrl: `http://127.0.0.1:${port}`,
			egressUrl: `http://127.0.0.1:${port}`,
			allowLocalHttp: true,
			host: '127.0.0.1',
			port: 0,
			async readObject(key) {
				const object = await objects.get(key)
				if (!object) throw new Error('Missing proof graph')
				return object.json()
			},
		})
		let invocations = 0
		const runner = createAgentCoreRunner({
			region: 'us-east-1',
			runtimeArn: 'synthetic-test-only',
			async send(command) {
				invocations++
				if (scenario === 'unavailable-runtime') return { statusCode: 503 }
				const response = await fetch(`${host.origin}/invocations`, {
					method: 'POST',
					headers: {
						'x-amzn-bedrock-agentcore-runtime-session-id':
							command.input.runtimeSessionId!,
					},
					body: command.input.payload,
				})
				if (scenario === 'lost-response') {
					await response.arrayBuffer()
					throw new Error('Synthetic response lost after dispatch')
				}
				return { statusCode: response.status, response: response.body! }
			},
		})
		try {
			const proof = proveRuntime(
				{
					region: 'us-east-1',
					s3: { bucket: 'proof' },
					runtime: {
						arn: 'synthetic-test-only',
						protocol: 'kody-deno-v1',
						broker: { port, publicUrl: 'https://proof.example.test' },
					},
				},
				{ objects, runner },
			)
			if (scenario === 'success')
				expect(await proof).toMatchObject({
					protocol: 'kody-deno-v1',
					brokerCalls: 1,
					outcomeRecorded: true,
				})
			else if (scenario === 'unavailable-runtime')
				await expect(proof).rejects.toThrow(PendingProof)
			else await expect(proof).rejects.toThrow('Workflow execution failed')
			expect(invocations).toBe(1)
			expect(writes).toHaveLength(scenario === 'success' ? 3 : 2)
			if (scenario === 'success')
				expect(writes[2]).toMatch(/runner-inputs\/.+-result.json$/)
			expect([...fake.objects('proof').keys()]).toEqual([
				'keep-existing-object',
			])
			await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow(
				'fetch failed',
			)
		} finally {
			await host.close()
		}
	},
)

test('protocol and connectivity prerequisites stay pending before touching AWS', async () => {
	await expect(
		proveRuntime({
			region: 'us-east-1',
			runtime: { arn: 'unused', protocol: 'kody-deno-v1' },
		}),
	).rejects.toThrow('HTTPS broker ingress')
})
