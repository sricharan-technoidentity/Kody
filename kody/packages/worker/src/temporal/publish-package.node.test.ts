import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { publishPackage } from './publish-package.ts'

test('publish runs checks, requires human approval when locked, stores bundle before commit pointer', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		const writes: string[] = []
		const putObject = env.objects.put
		env.objects.put = (key, value) => {
			writes.push('bundle')
			putObject(key, value)
		}
		const putItem = env.kv.put
		env.kv.put = (item, condition) => {
			if (item.pk === 'alice:packages') writes.push('published-commit')
			putItem(item, condition)
		}
		for (const check of ['bundle', 'typecheck', 'lint'] as const) {
			env.interpreter.respondWith(check, { ok: true, output: '' })
		}
		const input = {
			env,
			userId: 'alice',
			packageId: 'pkg',
			commit: 'abc123',
			locked: true,
		}
		const result = await publishPackage({
			...input,
			approvedBy: { role: 'human', userId: 'alice' },
		})
		expect(env.interpreter.calls).toEqual(['bundle', 'typecheck', 'lint'])
		expect(env.objects.get(result.bundleKey)).toBeDefined()
		expect(result.publishedCommit).toBe('abc123')
		expect(env.kv.get('alice:packages', 'pkg')?.publishedCommit).toBe('abc123')
		expect(writes.indexOf('bundle')).toBeLessThan(
			writes.indexOf('published-commit'),
		)
		await expect(
			publishPackage({
				...input,
				approvedBy: { role: 'agent', userId: 'alice' },
			}),
		).rejects.toThrow('human')
	} finally {
		await close()
	}
})
