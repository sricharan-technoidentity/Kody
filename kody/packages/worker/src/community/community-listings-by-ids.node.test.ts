import { expect, test } from 'vitest'
import {
	createTestCommunityDb,
	type TestCommunityDb,
} from '#worker/test-support/aws/test-community-db.ts'
import {
	getCommunityListingById,
	insertCommunityBan,
	insertCommunityFork,
	insertCommunityListing,
	upsertCommunityRating,
} from './repo.ts'
import {
	getCommunityListingWithAggregates,
	getCommunityListingsByIds,
} from './service.ts'
import { type CommunityListingStatus } from './types.ts'

async function insertListing(
	database: TestCommunityDb,
	input: {
		id: string
		status?: CommunityListingStatus
		ownerUserId?: string
		kodyId?: string
	},
) {
	const kodyId = input.kodyId ?? input.id
	const ownerUserId = input.ownerUserId ?? 'owner-1'
	await insertCommunityListing(database.owner(ownerUserId), {
		id: input.id,
		owner_user_id: ownerUserId,
		package_id: `pkg-${input.id}`,
		source_id: `src-${input.id}`,
		kody_id: kodyId,
		name: `@owner/${kodyId}`,
		description: `${kodyId} helpers`,
		tags_json: '[]',
		category: 'other',
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-1',
		status: input.status ?? 'active',
	})
}

async function insertFork(
	database: TestCommunityDb,
	input: { id: string; forkerUserId: string },
) {
	await insertCommunityFork(database.owner(input.forkerUserId), {
		id: input.id,
		listing_id: 'listing-b',
		forker_user_id: input.forkerUserId,
		origin_commit: 'commit-1',
		forked_package_id: `pkg-${input.id}`,
		forked_source_id: `src-${input.id}`,
		target_kody_id: 'beta',
		listing_name: '@owner/beta',
		listing_kody_id: 'beta',
	})
}

test('getCommunityListingsByIds returns public listings in input order with batched aggregates', async () => {
	await using database = await createTestCommunityDb()
	const { community, admin, queries } = database

	queries.length = 0
	expect(
		await getCommunityListingsByIds(community, [], { includeDelisted: false }),
	).toEqual([])
	expect(queries).toEqual([])

	await insertListing(database, { id: 'listing-a', kodyId: 'alpha' })
	await insertListing(database, { id: 'listing-b', kodyId: 'beta' })
	await insertListing(database, { id: 'listing-c', kodyId: 'gamma' })
	await insertListing(database, {
		id: 'listing-delisted',
		kodyId: 'retired',
		status: 'delisted',
	})
	await insertListing(database, {
		id: 'listing-banned-owner',
		kodyId: 'banned-pkg',
		ownerUserId: 'owner-banned',
	})
	await insertCommunityBan(admin, {
		user_id: 'owner-banned',
		banned_by_user_id: 'admin-1',
		reason: 'spam',
	})
	await upsertCommunityRating(database.owner('rater-1'), {
		id: 'rating-b',
		listing_id: 'listing-b',
		user_id: 'rater-1',
		stars: 4,
		adaptation_effort: 2,
		note: 'private to the rater',
	})
	await insertFork(database, { id: 'fork-b-1', forkerUserId: 'forker-1' })
	await insertFork(database, { id: 'fork-b-2', forkerUserId: 'forker-2' })

	// Visitors see active listings only; delisted rows are moderation state.
	expect(
		await getCommunityListingById(community, {
			listingId: 'listing-delisted',
			includeDelisted: true,
		}),
	).toBeNull()
	expect(
		await getCommunityListingById(community, {
			listingId: 'missing',
			includeDelisted: false,
		}),
	).toBeNull()
	expect(
		await getCommunityListingById(community, {
			listingId: 'listing-banned-owner',
			includeDelisted: false,
		}),
	).toEqual(
		expect.objectContaining({
			id: 'listing-banned-owner',
			status: 'active',
		}),
	)
	// Another user's own writer cannot read the listing at all.
	expect(
		await getCommunityListingById(database.owner('rater-1'), {
			listingId: 'listing-a',
			includeDelisted: true,
		}),
	).toBeNull()

	queries.length = 0
	const publicRows = await getCommunityListingsByIds(
		community,
		[
			'listing-c',
			'missing',
			'listing-a',
			'listing-delisted',
			'listing-b',
			'listing-banned-owner',
		],
		{ includeDelisted: false },
	)
	expect(publicRows.map((listing) => listing.id)).toEqual([
		'listing-c',
		'listing-a',
		'listing-b',
		'listing-banned-owner',
	])
	expect(publicRows.find((listing) => listing.id === 'listing-b')).toEqual(
		expect.objectContaining({
			id: 'listing-b',
			averageStars: 4,
			ratingCount: 1,
			averageAdaptationEffort: 2,
			forkCount: 2,
		}),
	)
	expect(queries).toHaveLength(3)
	expect(queries.filter((query) => query.includes(' IN ('))).toHaveLength(3)

	const withDelisted = await getCommunityListingsByIds(
		admin,
		['listing-delisted', 'listing-a', 'missing'],
		{ includeDelisted: true },
	)
	expect(withDelisted.map((listing) => listing.id)).toEqual([
		'listing-delisted',
		'listing-a',
	])
	expect(
		await getCommunityListingById(admin, {
			listingId: 'listing-delisted',
			includeDelisted: true,
		}),
	).toEqual(
		expect.objectContaining({ id: 'listing-delisted', status: 'delisted' }),
	)

	const single = await getCommunityListingWithAggregates({
		env: {
			APP_DB: database.owner('visitor'),
			COMMUNITY_DB: community,
		} as unknown as Env,
		listingId: 'listing-b',
		includeDelisted: false,
	})
	expect(publicRows.find((listing) => listing.id === 'listing-b')).toEqual(
		single,
	)

	// The public and moderation roles never see rating notes or credentials,
	// and the public role cannot write.
	for (const sql of [
		'SELECT note FROM community_ratings',
		'SELECT email FROM users',
		'SELECT password_hash FROM users',
	]) {
		await expect(community.prepare(sql).all()).rejects.toThrow(
			/permission denied/,
		)
	}
	await expect(
		admin.prepare('SELECT note FROM community_ratings').all(),
	).rejects.toThrow(/permission denied/)
	await expect(
		community
			.prepare(`UPDATE community_listings SET name = 'x' WHERE id = ?`)
			.bind('listing-a')
			.run(),
	).rejects.toThrow(/read-only|permission denied/)
})
