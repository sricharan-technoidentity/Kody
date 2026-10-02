import { expect, test } from 'vitest'
import {
	createTestCommunityDb,
	type TestCommunityDb,
} from '#worker/test-support/aws/test-community-db.ts'
import { insertCommunityActivityEvent } from './profile-repo.ts'
import {
	countCommunityForksByListingIds,
	deleteCommunityForksForPackage,
	deleteCommunityListing,
	deleteCommunityRatingsByListingId,
	deleteOwnedCommunityListingEngagement,
	insertCommunityFork,
	insertCommunityListing,
	repointOrphanedCommunityForksToListing,
	upsertCommunityRating,
} from './repo.ts'
import { cleanupOrphanedCommunityForks } from './service.ts'

async function insertPlaidListing(database: TestCommunityDb, id: string) {
	await insertCommunityListing(database.owner('owner-1'), {
		id,
		owner_user_id: 'owner-1',
		package_id: `origin-package-${id}`,
		source_id: 'origin-source',
		kody_id: 'plaid',
		name: '@kody/plaid',
		description: '',
		tags_json: '[]',
		category: 'other',
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-origin',
		status: 'active',
	})
}

async function seedListingAndForks(database: TestCommunityDb) {
	await insertPlaidListing(database, 'listing-plaid')
	await database.pg.query(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, manifest_path, source_root, created_at, updated_at
		) VALUES
			('source-inert', 'user-kent', 'package', 'package-inert', 'repo-inert', 'package.json', '/', 'now', 'now'),
			('source-live', 'user-kent', 'package', 'package-live', 'repo-live', 'package.json', '/', 'now', 'now')`,
	)
	await database.pg.query(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES ('package-live', 'user-kent', '@kentcdodds/plaid', 'plaid', '', 'source-live')`,
	)
	const kent = database.owner('user-kent')
	for (const fork of [
		{
			id: 'fork-inert',
			pkg: 'package-inert',
			src: 'source-inert',
			target: 'plaid-inert',
		},
		{
			id: 'fork-live',
			pkg: 'package-live',
			src: 'source-live',
			target: 'plaid',
		},
		{
			id: 'fork-orphan',
			pkg: 'package-missing',
			src: 'source-missing',
			target: 'plaid-fork-test-cleanup',
		},
	]) {
		await insertCommunityFork(kent, {
			id: fork.id,
			listing_id: 'listing-plaid',
			forker_user_id: 'user-kent',
			origin_commit: 'commit-origin',
			forked_package_id: fork.pkg,
			forked_source_id: fork.src,
			target_kody_id: fork.target,
			listing_name: '@kody/plaid',
			listing_kody_id: 'plaid',
		})
	}
}

test('orphan fork cleanup and package delete drop leftover community_forks without touching healthy forks', async () => {
	await using database = await createTestCommunityDb()
	await seedListingAndForks(database)
	const { community } = database
	// Orphan cleanup is moderation: it sees every forker's rows and source ids.
	const env = { APP_DB: database.admin } as unknown as Env

	expect(
		await countCommunityForksByListingIds(community, ['listing-plaid']),
	).toEqual({ 'listing-plaid': 3 })

	const emptyFilter = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: [],
	})
	expect(emptyFilter).toEqual({
		applied: true,
		deletedCount: 0,
		orphans: [],
	})

	const preview = await cleanupOrphanedCommunityForks({
		env,
		apply: false,
	})
	expect(preview).toMatchObject({
		applied: false,
		deletedCount: 0,
		orphans: [
			expect.objectContaining({
				forkId: 'fork-orphan',
				forkedPackageId: 'package-missing',
				forkedSourceId: 'source-missing',
				targetKodyId: 'plaid-fork-test-cleanup',
			}),
		],
	})
	expect(
		await countCommunityForksByListingIds(community, ['listing-plaid']),
	).toEqual({ 'listing-plaid': 3 })

	// An ordinary writer sees only its own forks, so it finds no one else's.
	expect(
		await cleanupOrphanedCommunityForks({
			env: { APP_DB: database.owner('someone-else') } as unknown as Env,
			apply: false,
		}),
	).toEqual({ applied: false, deletedCount: 0, orphans: [] })

	const skippedHealthy = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: ['fork-inert', 'fork-live'],
	})
	expect(skippedHealthy).toEqual({
		applied: true,
		deletedCount: 0,
		orphans: [],
	})

	const applied = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: ['fork-orphan'],
	})
	expect(applied).toMatchObject({
		applied: true,
		deletedCount: 1,
		orphans: [expect.objectContaining({ forkId: 'fork-orphan' })],
	})
	expect(
		await countCommunityForksByListingIds(community, ['listing-plaid']),
	).toEqual({ 'listing-plaid': 2 })

	// Another user cannot delete kent's fork rows; kent can.
	expect(
		await deleteCommunityForksForPackage(database.owner('someone-else'), {
			userId: 'user-kent',
			packageId: 'package-live',
			sourceId: 'source-live',
		}),
	).toBe(0)
	expect(
		await deleteCommunityForksForPackage(database.owner('user-kent'), {
			userId: 'user-kent',
			packageId: 'package-live',
			sourceId: 'source-live',
		}),
	).toBe(1)
	expect(
		await countCommunityForksByListingIds(community, ['listing-plaid']),
	).toEqual({ 'listing-plaid': 1 })

	const remaining = await database.pg.query(
		`SELECT id, target_kody_id FROM community_forks`,
	)
	expect(remaining.rows).toEqual([
		{ id: 'fork-inert', target_kody_id: 'plaid-inert' },
	])
})

test("unpublish clears every user's engagement and republish re-points orphaned forks", async () => {
	await using database = await createTestCommunityDb()
	await seedListingAndForks(database)
	const owner = database.owner('owner-1')
	await upsertCommunityRating(database.owner('user-kent'), {
		id: 'rating-kent',
		listing_id: 'listing-plaid',
		user_id: 'user-kent',
		stars: 5,
		adaptation_effort: 1,
		note: 'only kent sees this',
	})
	await insertCommunityActivityEvent(owner, {
		id: 'event-published',
		actorUserId: 'owner-1',
		eventType: 'listing_published',
		listingId: 'listing-plaid',
	})
	const countRows = async (table: string) =>
		(
			await database.pg.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM ${table} WHERE listing_id = 'listing-plaid'`,
			)
		).rows[0]?.count

	// Only the listing owner may clear it, and only while the listing exists.
	await expect(
		deleteOwnedCommunityListingEngagement(
			database.owner('user-kent'),
			'listing-plaid',
		),
	).rejects.toThrow(/not owned/)
	// The owner's own writer cannot see or delete kent's rating directly.
	await deleteCommunityRatingsByListingId(owner, 'listing-plaid')
	expect(await countRows('community_ratings')).toBe(1)

	await deleteOwnedCommunityListingEngagement(owner, 'listing-plaid')
	expect(await countRows('community_ratings')).toBe(0)
	expect(await countRows('community_activity_events')).toBe(0)
	expect(
		await deleteCommunityListing(owner, {
			listingId: 'listing-plaid',
			ownerUserId: 'owner-1',
		}),
	).toBe(true)
	// Fork provenance survives unpublish, orphaned from any listing.
	expect(await countRows('community_forks')).toBe(3)

	await insertPlaidListing(database, 'listing-plaid-v2')
	await expect(
		repointOrphanedCommunityForksToListing(database.owner('user-kent'), {
			listingId: 'listing-plaid-v2',
			listingName: '@kody/plaid',
			listingKodyId: 'plaid',
		}),
	).rejects.toThrow(/not owned/)
	expect(
		await repointOrphanedCommunityForksToListing(owner, {
			listingId: 'listing-plaid-v2',
			listingName: '@kody/plaid',
			listingKodyId: 'plaid',
		}),
	).toBe(3)
	expect(
		await countCommunityForksByListingIds(database.community, [
			'listing-plaid-v2',
		]),
	).toEqual({ 'listing-plaid-v2': 3 })
	// Forks of a listing that still exists (even delisted) are never captured.
	await database.pg.query(
		`UPDATE community_listings SET status = 'delisted' WHERE id = 'listing-plaid-v2'`,
	)
	await insertPlaidListing(database, 'listing-plaid-v3')
	expect(
		await repointOrphanedCommunityForksToListing(owner, {
			listingId: 'listing-plaid-v3',
			listingName: '@kody/plaid',
			listingKodyId: 'plaid',
		}),
	).toBe(0)

	// Moderation hard delete uses the admin role directly.
	await upsertCommunityRating(database.owner('user-kent'), {
		id: 'rating-kent-v3',
		listing_id: 'listing-plaid-v3',
		user_id: 'user-kent',
		stars: 3,
		adaptation_effort: 3,
		note: null,
	})
	await deleteCommunityRatingsByListingId(database.admin, 'listing-plaid-v3')
	expect(
		(
			await database.pg.query(
				`SELECT 1 FROM community_ratings WHERE listing_id = 'listing-plaid-v3'`,
			)
		).rows,
	).toEqual([])
})
