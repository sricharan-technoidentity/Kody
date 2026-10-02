import { expect, test } from 'vitest'
import { createFakeKms } from '#worker/test-support/aws/fake-kms.ts'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { createKodyPayloadCodec, kodyKmsEncoding } from './codec.ts'

test('payloads are KMS-encrypted per workflow owner and never stored in clear text', async () => {
	const kms = createFakeKms()
	const codec = createKodyPayloadCodec({ kms, namespace: 'kody-core' })
	const payload = {
		metadata: { encoding: new TextEncoder().encode('json/plain') },
		data: new TextEncoder().encode('{"secret":"alice-only"}'),
	}
	const alice = {
		type: 'workflow',
		namespace: 'kody-core',
		workflowId: 'alice:publish:pkg',
	} as const
	const [encoded] = await codec.encode([payload], alice)
	expect(new TextDecoder().decode(encoded!.metadata!.encoding)).toBe(
		kodyKmsEncoding,
	)
	expect(new TextDecoder().decode(encoded!.data)).not.toContain('alice-only')
	expect(await codec.decode([encoded!], alice)).toEqual([payload])
	await expect(
		codec.decode([encoded!], { ...alice, workflowId: 'bob:publish:pkg' }),
	).rejects.toThrow('owner')
	// Relabelling the owner does not help: KMS binds the original context.
	const relabelled = {
		...encoded!,
		metadata: {
			...encoded!.metadata,
			'kody-user-id': new TextEncoder().encode('bob'),
		},
	}
	await expect(
		codec.decode([relabelled], { ...alice, workflowId: 'bob:publish:pkg' }),
	).rejects.toBeInstanceOf(Error)
	await expect(
		createKodyPayloadCodec({ kms, namespace: 'kody-exec' }).decode(
			[encoded!],
			alice,
		),
	).rejects.toBeInstanceOf(Error)

	const temporal = await createTemporalEnv({ kms, timeSkipping: true })
	try {
		await temporal.startWorker({ taskQueue: 'codec' })
		await temporal.client.workflow.execute('harnessDelay', {
			taskQueue: 'codec',
			workflowId: 'alice:codec-check',
			args: [1_000],
		})
		const history = await temporal.client.workflow
			.getHandle('alice:codec-check')
			.fetchHistory()
		const stored = (history.events ?? []).flatMap((event) => [
			...(event.workflowExecutionStartedEventAttributes?.input?.payloads ?? []),
			...(event.workflowExecutionCompletedEventAttributes?.result?.payloads ??
				[]),
		])
		expect(stored).toHaveLength(2)
		for (const raw of stored) {
			expect(new TextDecoder().decode(raw.metadata!['encoding']!)).toBe(
				kodyKmsEncoding,
			)
			expect(new TextDecoder().decode(raw.metadata!['kody-user-id']!)).toBe(
				'alice',
			)
		}
	} finally {
		await temporal.close()
	}
})
