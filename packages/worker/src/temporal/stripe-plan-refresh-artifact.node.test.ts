import { expect, test } from 'vitest'
import { buildTemporalUserHash } from '@kody-internal/shared/temporal/identifiers.ts'
import {
	deleteStripePlanRefreshArtifact,
	loadStripePlanRefreshArtifact,
	storeStripePlanRefreshArtifact,
} from './stripe-plan-refresh-artifact.ts'

function memoryKv() {
	const values = new Map<string, string>()
	return {
		get: async (key: string) => values.get(key) ?? null,
		put: async (key: string, value: string) => {
			values.set(key, value)
		},
		delete: async (key: string) => {
			values.delete(key)
		},
	} as unknown as KVNamespace
}

test('Stripe coordinator references keep the raw owner out of Temporal input', async () => {
	const kv = memoryKv()
	const userId = 'stable-user-id'
	const stored = await storeStripePlanRefreshArtifact({ kv, userId })

	expect(stored.coordinatorRef).not.toContain(userId)
	await expect(
		loadStripePlanRefreshArtifact({
			kv,
			coordinatorRef: stored.coordinatorRef,
			expectedOwnerHash: stored.userHash,
		}),
	).resolves.toMatchObject({ userId, ownerHash: stored.userHash })

	await deleteStripePlanRefreshArtifact({ kv, userId })
	await expect(
		loadStripePlanRefreshArtifact({
			kv,
			coordinatorRef: stored.coordinatorRef,
			expectedOwnerHash: await buildTemporalUserHash(userId),
		}),
	).rejects.toThrow('stripe_plan_refresh_artifact_not_found')
})

test('Stripe coordinator references cannot be substituted across owners', async () => {
	const kv = memoryKv()
	const stored = await storeStripePlanRefreshArtifact({
		kv,
		userId: 'owner-one',
	})
	await expect(
		loadStripePlanRefreshArtifact({
			kv,
			coordinatorRef: stored.coordinatorRef,
			expectedOwnerHash: await buildTemporalUserHash('owner-two'),
		}),
	).rejects.toThrow('stripe_plan_refresh_artifact_owner_mismatch')
})
