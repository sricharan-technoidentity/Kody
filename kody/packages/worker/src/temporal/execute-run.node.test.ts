import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { runnerSessionId } from '#worker/aws/agentcore-runner.ts'
import { verifyRunToken } from '#worker/runner/run-token.ts'
import { executeRun } from './execute-run.ts'

test('execute is idempotent, consumes a finite meter and records one bounded Runner result', async () => {
	const userId = 'a'.repeat(64)
	const { env, close } = await createTargetTestEnv({ userId })
	try {
		env.kv.put({
			pk: `${userId}:meters`,
			sk: 'execute_calls_per_day',
			remaining: 1,
		})
		env.runner.respondWith({ output: 'ok', sandboxComputeMs: 5 })
		const input = { env, userId, requestId: 'req-1', code: 'return 1' }
		const first = await executeRun(input)
		const duplicate = await executeRun(input)
		expect(first.workflowId).toBe(`${userId}:execute:req-1`)
		expect(duplicate.runId).toBe(first.runId)
		expect(first.result).toBe('ok')
		expect(new TextEncoder().encode(first.result).length).toBeLessThanOrEqual(
			100 * 1024,
		)
		expect(env.runner.invocations).toHaveLength(1)
		expect(env.runner.invocations[0]?.runtimeSessionId).toBe(
			runnerSessionId(userId, first.runId),
		)
		expect(env.runner.invocations[0]?.payload).toEqual({
			runToken: expect.any(String),
			bundleKey: `${userId}/runner-inputs/${first.runId}.json`,
			runId: first.runId,
		})
		const token = (env.runner.invocations[0]!.payload as { runToken: string })
			.runToken
		expect(
			await verifyRunToken(env.RUN_TOKEN_SIGNING_KEY, token),
		).toMatchObject({ userId, runId: first.runId, retriever: false })
		expect(
			env.kv.get(`${userId}:meters`, 'execute_calls_per_day')?.remaining,
		).toBe(0)
		await expect(executeRun({ ...input, requestId: 'req-2' })).rejects.toThrow(
			'entitlement',
		)
		env.kv.update(`${userId}:meters`, 'execute_calls_per_day', (item) => ({
			...item!,
			remaining: 1,
		}))
		env.runner.respondWith({
			output: 'x'.repeat(150 * 1024),
			sandboxComputeMs: 5,
		})
		const large = await executeRun({ ...input, requestId: 'req-3' })
		expect(new TextEncoder().encode(large.result).length).toBeLessThanOrEqual(
			100 * 1024,
		)
	} finally {
		await close()
	}
}, 60_000)

test(
	'ExecuteRun activity resolves its S3 graph inside real workerd',
	{ timeout: 60_000 },
	async () => {
		const { createDenoFixtureRunner } =
			await import('#worker/test-support/deno-fixture-runner.ts')
		const { createServer } = await import('node:http')
		const { env, close } = await createTargetTestEnv({ userId: 'alice' })
		const endpoints = createServer((_request, response) => {
			response.writeHead(403)
			response.end('No capabilities registered')
		})
		await new Promise<void>((resolve) =>
			endpoints.listen(0, '127.0.0.1', resolve),
		)
		try {
			const address = endpoints.address() as { port: number }
			await using runner = await createDenoFixtureRunner({
				brokerUrl: `http://127.0.0.1:${address.port}`,
				egressUrl: `http://127.0.0.1:${address.port}`,
				async readObject(key) {
					const object = env.objects.get(key)
					if (!object) throw new Error('Missing S3 bundle')
					return JSON.parse(new TextDecoder().decode(object))
				},
			})
			env.runner.invoke = (input) =>
				runner.invoke(
					input.payload as {
						bundleKey: string
						runToken: string
						runId: string
					},
				)
			env.kv.put({
				pk: 'alice:meters',
				sk: 'execute_calls_per_day',
				remaining: 1,
			})
			const result = await executeRun({
				env,
				userId: 'alice',
				requestId: 'native',
				code: 'return 1 + 1',
			})
			expect(result.result).toBe('2')
			expect(env.kv.query('alice:runs')).toHaveLength(1)
			await expect(
				executeRun({
					env,
					userId: 'bob',
					requestId: 'owner',
					code: 'return 3',
				}),
			).rejects.toThrow('owner')
		} finally {
			await close()
			await new Promise<void>((resolve) => endpoints.close(() => resolve()))
		}
	},
)
