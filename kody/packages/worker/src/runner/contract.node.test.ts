import { expect, test } from 'vitest'
import { createRunnerLoader } from './loader.ts'
import {
	parseRunnerInvocation,
	runnerInputKey,
	claimRunnerDispatch,
} from './contract.ts'

test('Runner accepts only three reference fields and safe owner/run key components', () => {
	const payload = {
		bundleKey: runnerInputKey('alice', 'one'),
		runToken: 'token',
		runId: 'one',
	}
	expect(parseRunnerInvocation(payload)).toEqual(payload)
	for (const value of [
		null,
		[],
		{},
		{ ...payload, surface: 'execute' },
		{ ...payload, runId: '' },
	])
		expect(() => parseRunnerInvocation(value)).toThrow('reference')
	for (const id of ['', '.', '..', '../bob', 'a/b', 'a\\b', 'a\n']) {
		expect(() => runnerInputKey('alice', id)).toThrow('identity')
		expect(() => runnerInputKey(id, 'one')).toThrow('identity')
	}
})

test('existing or uncertain durable dispatch claims cannot be replayed', async () => {
	for (const store of [
		{
			async claimIdempotencyKey() {
				return {
					claimed: false as const,
					existing: { runId: 'one', status: 'running' as const, claimedAt: '' },
				}
			},
		},
		{
			async claimIdempotencyKey(): Promise<never> {
				throw new Error('Lost claim response')
			},
		},
	]) {
		await expect(
			claimRunnerDispatch(store, 'alice', 'one'),
		).rejects.toMatchObject({ name: 'RunnerInvocationError', dispatched: true })
	}
})

test.each(['store', 'invoke', 'success'] as const)(
	'shared graph preparation cleans up and classifies the %s boundary',
	async (phase) => {
		const calls: Array<string> = []
		const loader = createRunnerLoader({
			idempotency: {
				async claimIdempotencyKey() {
					return { claimed: true }
				},
			},
			async prepare(context, runId) {
				calls.push(`prepare:${context.userId}:${runId}`)
				return { runId: runId!, runToken: 'token', runtimeSessionId: 'session' }
			},
			register() {
				calls.push('register')
				return () => {
					calls.push('unregister')
				}
			},
			async putObject(key) {
				calls.push(key)
				if (phase === 'store') throw new Error('S3 unavailable')
			},
			async invoke(input) {
				calls.push('invoke')
				expect(input.payload).toEqual({
					bundleKey: 'alice/runner-inputs/one.json',
					runToken: 'token',
					runId: 'one',
				})
				if (phase === 'invoke') throw new Error('Response lost')
				return { result: 42 }
			},
		})
		const execution = loader
			.forContext({
				userId: 'alice',
				email: null,
				storageContext: null,
				baseUrl: 'https://kody.dev',
			})
			.invokeGraph(
				{
					mainModule: 'main.js',
					modules: { 'main.js': 'export default {}' },
					compatibilityDate: '2026-04-16',
					compatibilityFlags: [],
				},
				{},
				'one',
			)
		if (phase === 'success')
			await expect(execution).resolves.toEqual({ result: 42 })
		else
			await expect(execution).rejects.toMatchObject({
				name: 'RunnerInvocationError',
				dispatched: phase === 'invoke',
			})
		expect(calls).toEqual([
			'prepare:alice:one',
			'register',
			'alice/runner-inputs/one.json',
			...(phase === 'store' ? [] : ['invoke']),
			'unregister',
		])
	},
)
