import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	deleteArtifactsPushSubscriptionBySourceId,
	getArtifactsPushSubscriptionBySourceId,
	upsertArtifactsPushSubscription,
} from './artifacts-push-subscription-store.ts'

test('artifacts push subscription store upserts, reads, and deletes by source', async () => {
	await using database = await createTestDb({ userId: 'user-1' })
	const db = database.db
	await upsertArtifactsPushSubscription(db, {
		source_id: 'source-1',
		user_id: 'user-1',
		repo_id: 'repo-1',
		subscription_id: 'sub-1',
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-01T00:00:00.000Z',
	})
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toMatchObject({
		subscription_id: 'sub-1',
		repo_id: 'repo-1',
	})

	await upsertArtifactsPushSubscription(db, {
		source_id: 'source-1',
		user_id: 'user-1',
		repo_id: 'repo-1',
		subscription_id: 'sub-2',
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-02T00:00:00.000Z',
	})
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toMatchObject({
		subscription_id: 'sub-2',
	})

	await expect(
		deleteArtifactsPushSubscriptionBySourceId(db, {
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toBe(true)
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toBeNull()
})

test('artifacts push subscription store returns null when the side table is absent', async () => {
	await using database = await createTestDb({ userId: 'user-1' })
	await database.pg.exec(
		'DROP TABLE entity_source_artifacts_push_subscriptions',
	)
	const db = database.db
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toBeNull()
	await expect(
		deleteArtifactsPushSubscriptionBySourceId(db, {
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toBe(false)
})
