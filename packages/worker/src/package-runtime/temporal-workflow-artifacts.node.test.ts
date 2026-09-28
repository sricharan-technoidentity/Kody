import { expect, test } from 'vitest'
import {
	loadTemporalWorkflowOwner,
	loadTemporalWorkflowPayload,
	storeTemporalWorkflowArtifacts,
} from './temporal-workflow-artifacts.ts'

function createMemoryKv() {
	const values = new Map<string, string>()
	return {
		values,
		kv: {
			put: async (key: string, value: string) => {
				values.set(key, value)
			},
			get: async (key: string) => values.get(key) ?? null,
		} as unknown as KVNamespace,
	}
}

test('workflow artifacts round-trip without placing owner identity in source history', async () => {
	const memory = createMemoryKv()
	const payload = {
		version: 3 as const,
		sourceType: 'inline' as const,
		userId: 'user-private-1',
		packageContext: null,
		workflowName: 'inline-code',
		code: 'export default () => ({ ok: true })',
		idempotencyKey: 'logical-operation-1',
		runAt: '2026-09-23T00:00:00.000Z',
		planDate: '2026-09-23',
		params: { ok: true },
	}
	const refs = await storeTemporalWorkflowArtifacts({
		kv: memory.kv,
		payload,
	})

	expect(refs.sourceRef).not.toContain(payload.userId)
	expect(refs.callerContextRef).not.toContain(payload.userId)
	expect(refs.sourceRef).toMatch(/^artifact:workflow-source\./)
	expect(
		await loadTemporalWorkflowOwner({
			kv: memory.kv,
			userHash: refs.ownerHash,
			callerContextRef: refs.callerContextRef,
		}),
	).toBe(payload.userId)
	expect(
		await loadTemporalWorkflowPayload({
			kv: memory.kv,
			userHash: refs.ownerHash,
			sourceRef: refs.sourceRef,
			callerContextRef: refs.callerContextRef,
		}),
	).toEqual(payload)
})

test('workflow artifacts reject cross-owner and tampered references', async () => {
	const memory = createMemoryKv()
	const refs = await storeTemporalWorkflowArtifacts({
		kv: memory.kv,
		payload: {
			version: 2,
			sourceType: 'package',
			userId: 'user-private-1',
			packageId: 'pkg-1',
			kodyId: 'sample-package',
			sourceId: 'source-1',
			workflowName: './run',
			exportName: './run',
			idempotencyKey: 'logical-operation-1',
			runAt: '2026-09-23T00:00:00.000Z',
			planDate: '2026-09-23',
		},
	})

	await expect(
		loadTemporalWorkflowPayload({
			kv: memory.kv,
			userHash: 'z'.repeat(32),
			sourceRef: refs.sourceRef,
			callerContextRef: refs.callerContextRef,
		}),
	).rejects.toThrow('workflow_artifact_owner_mismatch')
	await expect(
		loadTemporalWorkflowPayload({
			kv: memory.kv,
			userHash: refs.ownerHash,
			sourceRef: `${refs.sourceRef.slice(0, -1)}0`,
			callerContextRef: refs.callerContextRef,
		}),
	).rejects.toThrow('workflow_artifact_not_found')
})
