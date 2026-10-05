import { expect, test } from 'vitest'
import { runAwsProofs } from './aws-check.ts'

test('unconfigured live proofs remain pending with no fallback success', async () => {
	const report = await runAwsProofs()
	expect(report).toHaveLength(9)
	expect(report.every((proof) => proof.status === 'pending')).toBe(true)
	expect(report.map((proof) => proof.service)).toContain('runtime')
})
test('missing consent/runtime prerequisites are pending and other unconfigured services remain pending', async () => {
	const report = await runAwsProofs({
		region: 'us-east-1',
		runtime: {
			arn: 'unused',
			protocol: 'old-runner',
		},
	})
	expect(report.every((proof) => proof.status === 'pending')).toBe(true)
	expect(
		report.find((proof) => proof.service === 'runtime')?.evidence,
	).toContain('kody-deno-v1')
})
