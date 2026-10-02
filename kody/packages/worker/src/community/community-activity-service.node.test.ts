import { expect, test } from 'vitest'
import { createTestCommunityDb } from '#worker/test-support/aws/test-community-db.ts'
import {
	countCommunityForksByListingIds,
	deleteCommunityListing,
	insertCommunityFork,
	insertCommunityListing,
	upsertCommunityRating,
} from './repo.ts'
import {
	getCommunityActivityForAdmin,
	listCommunityActivityForAdmin,
} from './service.ts'

test('admin community activity reads forks and latest ratings newest-first with pagination and filters', async () => {
	await using database = await createTestCommunityDb()
	// Activity review runs as kody_admin after the permission check.
	const db = database.admin
	await database.pg.query(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('forker', 'forker@example.com', 'hash', 'user-forker'),
			('rater', 'rater@example.com', 'hash', 'user-rater')`,
	)
	for (const listing of [
		{ id: 'listing-1', kodyId: 'alpha', name: '@owner/alpha' },
		{ id: 'listing-2', kodyId: 'beta', name: '@owner/beta' },
	]) {
		await insertCommunityListing(database.owner('owner'), {
			id: listing.id,
			owner_user_id: 'owner',
			package_id: `package-${listing.id}`,
			source_id: `source-${listing.id}`,
			kody_id: listing.kodyId,
			name: listing.name,
			description: 'description',
			tags_json: '[]',
			category: 'other',
			search_text: null,
			readme_content: null,
			license: 'MIT',
			pinned_commit: 'commit-1',
			status: 'active',
			created_at: '2026-07-20T00:00:00.000Z',
			updated_at: '2026-07-20T00:00:00.000Z',
			published_at: '2026-07-20T00:00:00.000Z',
		})
	}

	for (const fork of [
		{
			id: 'fork-1',
			listingId: 'listing-1',
			createdAt: '2026-07-20T00:01:00.000Z',
		},
		{
			id: 'fork-2',
			listingId: 'listing-1',
			createdAt: '2026-07-20T00:02:00.000Z',
		},
		{
			id: 'fork-3',
			listingId: 'listing-2',
			createdAt: '2026-07-20T00:03:00.000Z',
		},
	]) {
		await insertCommunityFork(database.owner('user-forker'), {
			id: fork.id,
			listing_id: fork.listingId,
			forker_user_id: 'user-forker',
			origin_commit: 'commit-1',
			forked_package_id: `package-${fork.id}`,
			forked_source_id: `source-${fork.id}`,
			target_kody_id: `target-${fork.id}`,
			listing_name:
				fork.listingId === 'listing-1' ? '@owner/alpha' : '@owner/beta',
			listing_kody_id: fork.listingId === 'listing-1' ? 'alpha' : 'beta',
			created_at: fork.createdAt,
		})
	}

	const rater = database.owner('user-rater')
	const firstRating = await upsertCommunityRating(rater, {
		id: 'rating-original',
		listing_id: 'listing-1',
		user_id: 'user-rater',
		stars: 4,
		adaptation_effort: 3,
		note: 'not exposed',
		created_at: '2026-07-20T00:04:00.000Z',
		updated_at: '2026-07-20T00:04:00.000Z',
	})
	const updatedRating = await upsertCommunityRating(rater, {
		id: 'rating-replacement',
		listing_id: 'listing-1',
		user_id: 'user-rater',
		stars: 5,
		adaptation_effort: 1,
		note: 'still not exposed',
		created_at: '2026-07-20T00:05:00.000Z',
		updated_at: '2026-07-20T00:05:00.000Z',
	})
	expect(firstRating.id).toBe('rating-original')
	expect(updatedRating).toMatchObject({
		id: 'rating-original',
		stars: 5,
		adaptationEffort: 1,
		updatedAt: '2026-07-20T00:05:00.000Z',
	})

	const firstPage = await listCommunityActivityForAdmin({ db, pageSize: 2 })
	expect(firstPage).toMatchObject({ total: 4, page: 1, pageSize: 2 })
	expect(firstPage.items).toEqual([
		{
			id: 'rating-original',
			kind: 'rating',
			listingId: 'listing-1',
			listingName: '@owner/alpha',
			listingKodyId: 'alpha',
			actingUsername: 'rater',
			occurredAt: '2026-07-20T00:05:00.000Z',
			stars: 5,
			adaptationEffort: 1,
		},
		{
			id: 'fork-3',
			kind: 'fork',
			listingId: 'listing-2',
			listingName: '@owner/beta',
			listingKodyId: 'beta',
			actingUsername: 'forker',
			occurredAt: '2026-07-20T00:03:00.000Z',
		},
	])

	const clamped = await listCommunityActivityForAdmin({
		db,
		page: 99,
		pageSize: 2,
	})
	expect(clamped.page).toBe(2)
	expect(clamped.items.map((item) => item.id)).toEqual(['fork-2', 'fork-1'])

	const filtered = await listCommunityActivityForAdmin({
		db,
		kind: 'rating',
		listingId: 'listing-1',
	})
	expect(filtered.total).toBe(1)
	expect(filtered.items).toEqual([firstPage.items[0]])
	expect(
		await getCommunityActivityForAdmin({
			db,
			kind: 'rating',
			activityId: 'rating-original',
		}),
	).toEqual(firstPage.items[0])

	expect(
		await deleteCommunityListing(database.owner('owner'), {
			listingId: 'listing-2',
			ownerUserId: 'owner',
		}),
	).toBe(true)
	const deletedListingActivity = await listCommunityActivityForAdmin({
		db,
		kind: 'fork',
		listingId: 'listing-2',
	})
	expect(deletedListingActivity.items).toEqual([
		{
			id: 'fork-3',
			kind: 'fork',
			listingId: 'listing-2',
			listingName: '@owner/beta',
			listingKodyId: 'beta',
			actingUsername: 'forker',
			occurredAt: '2026-07-20T00:03:00.000Z',
		},
	])

	expect(
		await countCommunityForksByListingIds(db, [
			'listing-1',
			'listing-2',
			'listing-without-forks',
		]),
	).toEqual({
		'listing-1': 2,
		'listing-2': 1,
		'listing-without-forks': 0,
	})
	// Visitors count forks of active listings only.
	expect(
		await countCommunityForksByListingIds(database.community, [
			'listing-1',
			'listing-2',
		]),
	).toEqual({ 'listing-1': 2, 'listing-2': 0 })
})
