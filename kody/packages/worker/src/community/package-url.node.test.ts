import { expect, test } from 'vitest'
import {
	createTestCommunityDb,
	type TestCommunityDb,
} from '#worker/test-support/aws/test-community-db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	deletePackageKodyIdRedirects,
	releasePackageKodyIdRedirect,
	resolveCommunityPackageUrl,
	resolvePackagePageUrl,
	retirePackageKodyId,
	retireUsername,
} from './package-url.ts'

let database: TestCommunityDb

/** Fixture rows are seeded as the schema owner; resolution runs as a visitor. */
async function runSql(sql: string, ...values: Array<unknown>) {
	await database.pg.query(
		sql.replace(
			/\?/g,
			(() => {
				let index = 0
				return () => `$${++index}`
			})(),
		),
		values,
	)
}

function uniqueSuffix() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

async function insertUser(username: string) {
	const email = `${username}-${uniqueSuffix()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await runSql(
		`INSERT INTO users (
			username, email, stable_user_id, profile_visibility, password_hash, plan
		) VALUES (?, ?, ?, 'public', 'test-password-hash', 'max')`,
		username,
		email,
		userId,
	)
	return { userId, username }
}

async function renameUser(input: { userId: string; username: string }) {
	await runSql(
		`UPDATE users SET username = ? WHERE stable_user_id = ?`,
		input.username,
		input.userId,
	)
}

async function insertPackage(input: {
	id: string
	userId: string
	kodyId: string
}) {
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, is_private
		) VALUES (?, ?, ?, ?, ?, ?, 0)`,
		input.id,
		input.userId,
		`@owner/${input.kodyId}`,
		input.kodyId,
		`${input.kodyId} description`,
		`source-${input.id}`,
	)
}

async function insertListing(input: {
	id: string
	ownerUserId: string
	packageId: string
	kodyId: string
	status?: 'active' | 'delisted'
}) {
	await runSql(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			license, pinned_commit, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'MIT', 'commit-1', ?)`,
		input.id,
		input.ownerUserId,
		input.packageId,
		`source-${input.packageId}`,
		input.kodyId,
		`@owner/${input.kodyId}`,
		`${input.kodyId} description`,
		input.status ?? 'active',
	)
}

/**
 * One owner with one published package, addressed as `/@username/kodyId`.
 */
async function createPublishedPackage(kodyId = 'devin') {
	const suffix = uniqueSuffix()
	const user = await insertUser(`owner${suffix}`)
	const packageId = `pkg-${suffix}`
	const listingId = `listing-${suffix}`
	await insertPackage({ id: packageId, userId: user.userId, kodyId })
	await insertListing({
		id: listingId,
		ownerUserId: user.userId,
		packageId,
		kodyId,
	})
	return { ...user, packageId, listingId, kodyId }
}

test('canonical pairs resolve, miss, delist, and case-correct to the listing', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage()

	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'listing',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})

	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: `nobody${uniqueSuffix()}`,
			kodyId: pkg.kodyId,
		}),
	).resolves.toBeNull()
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: 'not-published',
		}),
	).resolves.toBeNull()
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: 'Not A Kody Id',
		}),
	).resolves.toBeNull()

	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username.toUpperCase(),
			kodyId: pkg.kodyId.toUpperCase(),
		}),
	).resolves.toEqual({
		kind: 'redirect',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})

	const suffix = uniqueSuffix()
	const delistedOwner = await insertUser(`owner${suffix}`)
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: delistedOwner.userId,
		kodyId: 'devin',
	})
	await insertListing({
		id: `listing-${suffix}`,
		ownerUserId: delistedOwner.userId,
		packageId: `pkg-${suffix}`,
		kodyId: 'devin',
		status: 'delisted',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: delistedOwner.username,
			kodyId: 'devin',
		}),
	).resolves.toBeNull()
})

test('retired usernames redirect through rename chains until a reclaim wins', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage()
	const middle = `middle${uniqueSuffix()}`
	const latest = `latest${uniqueSuffix()}`

	await renameUser({ userId: pkg.userId, username: middle })
	await retireUsername({
		db: database.owner(pkg.userId),
		oldUsername: pkg.username,
		newUsername: middle,
		userId: pkg.userId,
	})
	await renameUser({ userId: pkg.userId, username: latest })
	await retireUsername({
		db: database.owner(pkg.userId),
		oldUsername: middle,
		newUsername: latest,
		userId: pkg.userId,
	})

	for (const oldUsername of [pkg.username, middle]) {
		await expect(
			resolveCommunityPackageUrl({
				db: database.community,
				username: oldUsername,
				kodyId: pkg.kodyId,
			}),
		).resolves.toEqual({
			kind: 'redirect',
			listingId: pkg.listingId,
			username: latest,
			kodyId: pkg.kodyId,
		})
	}

	// Someone else takes the released username and publishes under it.
	const suffix = uniqueSuffix()
	const claimer = await insertUser(pkg.username)
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: claimer.userId,
		kodyId: pkg.kodyId,
	})
	await insertListing({
		id: `listing-${suffix}`,
		ownerUserId: claimer.userId,
		packageId: `pkg-${suffix}`,
		kodyId: pkg.kodyId,
	})

	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'listing',
		listingId: `listing-${suffix}`,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})
})

test('retired kody ids follow the package, die when unpublished, and clear on claim or delete', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage()
	await runSql(
		`UPDATE saved_packages SET kody_id = 'devin-two' WHERE id = ?`,
		pkg.packageId,
	)
	await runSql(
		`UPDATE community_listings SET kody_id = 'devin-two' WHERE id = ?`,
		pkg.listingId,
	)
	await retirePackageKodyId({
		db: database.owner(pkg.userId),
		userId: pkg.userId,
		packageId: pkg.packageId,
		oldKodyId: pkg.kodyId,
		newKodyId: 'devin-two',
	})

	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'redirect',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: 'devin-two',
	})

	const deadEnd = await createPublishedPackage('dead-end')
	await runSql(
		`UPDATE saved_packages SET kody_id = 'dead-end-two' WHERE id = ?`,
		deadEnd.packageId,
	)
	await runSql(`DELETE FROM community_listings WHERE id = ?`, deadEnd.listingId)
	await retirePackageKodyId({
		db: database.owner(deadEnd.userId),
		userId: deadEnd.userId,
		packageId: deadEnd.packageId,
		oldKodyId: deadEnd.kodyId,
		newKodyId: 'dead-end-two',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: deadEnd.username,
			kodyId: deadEnd.kodyId,
		}),
	).resolves.toBeNull()

	const released = await createPublishedPackage('release-me')
	await retirePackageKodyId({
		db: database.owner(released.userId),
		userId: released.userId,
		packageId: released.packageId,
		oldKodyId: 'release-old',
		newKodyId: released.kodyId,
	})
	await deletePackageKodyIdRedirects({
		db: database.owner(released.userId),
		userId: released.userId,
		packageId: released.packageId,
	})
	const remaining = await database.pg.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM package_kody_id_redirects WHERE package_id = $1`,
		[released.packageId],
	)
	expect(remaining.rows[0]?.count).toBe(0)

	const claim = await createPublishedPackage('claim-me')
	// An earlier package of the same owner moved off `claim-old`, then a new
	// package takes the freed id: the old forwarding row has to go, or the new
	// package's own URL would send visitors to its predecessor.
	await retirePackageKodyId({
		db: database.owner(claim.userId),
		userId: claim.userId,
		packageId: `pkg-other-${uniqueSuffix()}`,
		oldKodyId: 'claim-old',
		newKodyId: 'claim-new',
	})
	await releasePackageKodyIdRedirect({
		db: database.owner(claim.userId),
		userId: claim.userId,
		kodyId: 'claim-old',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: claim.username,
			kodyId: 'claim-old',
		}),
	).resolves.toBeNull()
})

test('one owner cannot have two active listings on one kody id', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage()
	const suffix = uniqueSuffix()
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: pkg.userId,
		kodyId: `other-${suffix}`,
	})

	await expect(
		insertListing({
			id: `listing-${suffix}`,
			ownerUserId: pkg.userId,
			packageId: `pkg-${suffix}`,
			kodyId: pkg.kodyId,
		}),
	).rejects.toThrow(/UNIQUE/i)
})

test('package page URL resolves unpublished saved packages and listed ones', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const listed = await createPublishedPackage('listed-notes')
	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: listed.username,
			kodyId: listed.kodyId,
		}),
	).resolves.toMatchObject({
		kind: 'package',
		username: listed.username,
		kodyId: listed.kodyId,
		userId: listed.userId,
		listingId: listed.listingId,
		savedPackage: { id: listed.packageId, kodyId: listed.kodyId },
	})

	const suffix = uniqueSuffix()
	const owner = await insertUser(`unlisted${suffix}`)
	const packageId = `pkg-${suffix}`
	await insertPackage({
		id: packageId,
		userId: owner.userId,
		kodyId: 'private-notes',
	})
	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: owner.username,
			kodyId: 'private-notes',
		}),
	).resolves.toMatchObject({
		kind: 'package',
		username: owner.username,
		kodyId: 'private-notes',
		userId: owner.userId,
		listingId: null,
		savedPackage: { id: packageId, kodyId: 'private-notes' },
	})
	await expect(
		resolveCommunityPackageUrl({
			db: database.community,
			username: owner.username,
			kodyId: 'private-notes',
		}),
	).resolves.toBeNull()
})

test('package page URL attaches the saved package when listing kody id lags a rename', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage('listing-lag')
	await runSql(
		`UPDATE saved_packages SET kody_id = 'listing-lag-two' WHERE id = ?`,
		pkg.packageId,
	)
	await retirePackageKodyId({
		db: database.owner(pkg.userId),
		userId: pkg.userId,
		packageId: pkg.packageId,
		oldKodyId: pkg.kodyId,
		newKodyId: 'listing-lag-two',
	})

	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toMatchObject({
		kind: 'package',
		username: pkg.username,
		kodyId: pkg.kodyId,
		userId: pkg.userId,
		listingId: pkg.listingId,
		listingKodyId: pkg.kodyId,
		savedPackage: { id: pkg.packageId, kodyId: 'listing-lag-two' },
	})
	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: pkg.username,
			kodyId: 'listing-lag-two',
		}),
	).resolves.toMatchObject({
		kind: 'package',
		username: pkg.username,
		kodyId: 'listing-lag-two',
		userId: pkg.userId,
		listingId: pkg.listingId,
		listingKodyId: pkg.kodyId,
		savedPackage: { id: pkg.packageId, kodyId: 'listing-lag-two' },
	})
	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: pkg.username.toUpperCase(),
			kodyId: pkg.kodyId.toUpperCase(),
		}),
	).resolves.toMatchObject({
		kind: 'redirect',
		username: pkg.username,
		kodyId: pkg.kodyId,
		listingId: pkg.listingId,
		listingKodyId: pkg.kodyId,
	})
})

test('claiming a username clears its retirement row and private packages stay unresolvable', async () => {
	await using db = await createTestCommunityDb()
	database = db
	const pkg = await createPublishedPackage('claimed')
	const renamed = `renamed${uniqueSuffix()}`
	await renameUser({ userId: pkg.userId, username: renamed })
	await retireUsername({
		db: database.owner(pkg.userId),
		oldUsername: pkg.username,
		newUsername: renamed,
		userId: pkg.userId,
	})

	// Another account takes the released name: its claim removes the previous
	// holder's retirement row, which owner RLS would otherwise hide from it.
	const claimer = await insertUser(`claimer${uniqueSuffix()}`)
	await renameUser({ userId: claimer.userId, username: pkg.username })
	await retireUsername({
		db: database.owner(claimer.userId),
		oldUsername: claimer.username,
		newUsername: pkg.username,
		userId: claimer.userId,
	})
	const redirects = await database.pg.query<{
		old_username: string
		user_id: string
	}>(
		`SELECT old_username, user_id FROM username_redirects ORDER BY old_username`,
	)
	expect(redirects.rows).toEqual([
		{ old_username: claimer.username, user_id: claimer.userId },
	])
	// A user who does not hold the name cannot clear someone's retirement row.
	await retireUsername({
		db: database.owner(pkg.userId),
		oldUsername: renamed,
		newUsername: claimer.username,
		userId: pkg.userId,
	})
	expect(
		(
			await database.pg.query(
				`SELECT 1 FROM username_redirects WHERE old_username = $1`,
				[claimer.username],
			)
		).rows,
	).toHaveLength(1)

	const suffix = uniqueSuffix()
	const owner = await insertUser(`private${suffix}`)
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, is_private
		) VALUES (?, ?, ?, 'secret-notes', 'secret', ?, 1)`,
		`pkg-${suffix}`,
		owner.userId,
		`@owner/secret-notes`,
		`source-pkg-${suffix}`,
	)
	await expect(
		resolvePackagePageUrl({
			db: database.community,
			username: owner.username,
			kodyId: 'secret-notes',
		}),
	).resolves.toBeNull()
	await expect(
		resolvePackagePageUrl({
			db: database.owner(owner.userId),
			username: owner.username,
			kodyId: 'secret-notes',
		}),
	).resolves.toMatchObject({ kind: 'package', listingId: null })
})
