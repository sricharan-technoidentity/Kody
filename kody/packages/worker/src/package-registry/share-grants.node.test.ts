import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import {
	getSavedPackageById,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	acceptPackageShare,
	findSharePeer,
	acknowledgePackageShareUpdate,
	assertPackageShareUseAllowed,
	attachPendingPackageShareInvitesForEmail,
	authorizeSharedPackagePermission,
	collectShareStorageOwners,
	grantIsAddressedToGuest,
	hydratePackageShareGrantViews,
	invitePackageShare,
	isShareGrantedForeignPackage,
	listAcceptedInboundSharedPackages,
	leavePackageShare,
	listInboundPackageShareGrants,
	listOutboundPackageShareGrants,
	PackageSharePaidRequiredError,
	PackageSharePinAheadError,
	resolvePackageStorageOwnerUserId,
	retainAuthorizedPackageStorageGrantIds,
	resolveShareGrantedPackageImport,
	revokePackageShare,
} from './share-grants.ts'
import {
	disablePackageShareGrantsForTests,
	enablePackageShareGrantsForTests,
} from './share-flag.ts'

const ownerUserId = 'aa'.repeat(32)
const guestUserId = 'bb'.repeat(32)
const freeUserId = 'cc'.repeat(32)

/**
 * One PGlite schema. Each party acts through its own scoped writer (`as`);
 * `sql` seeds fixtures as the schema owner and `admin` toggles the flag.
 */
async function createShareDb() {
	const database = await createTestDb()
	return {
		...database,
		as: (userId: string) => database.forUser(userId).db,
		admin: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
		async sql(text: string, ...values: Array<unknown>) {
			let index = 0
			await database.pg.query(
				text.replace(/\?/g, () => `$${++index}`),
				values,
			)
		},
	}
}
type ShareDb = Awaited<ReturnType<typeof createShareDb>>

async function insertUser(
	db: ShareDb,
	input: {
		username: string
		email: string
		userId: string
		plan: 'free' | 'standard' | 'pro'
		emailVerified?: boolean
	},
) {
	await db.sql(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
		VALUES (?, ?, 'x', ?, ?, ?)`,
		input.username,
		input.email,
		input.emailVerified === false ? null : new Date().toISOString(),
		input.userId,
		input.plan,
	)
}

async function seedPublishedPackage(
	db: ShareDb,
	input: {
		userId: string
		name: string
		kodyId: string
		publishedCommit?: string
	},
) {
	const id = crypto.randomUUID()
	const sourceId = `source-${id}`
	const now = new Date().toISOString()
	await insertSavedPackage(db.as(input.userId), {
		id,
		user_id: input.userId,
		name: input.name,
		kody_id: input.kodyId,
		description: `${input.name} test package`,
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(db.as(input.userId), {
		id: sourceId,
		user_id: input.userId,
		entity_kind: 'package',
		entity_id: id,
		repo_id: `repo-${sourceId}`,
		published_commit: input.publishedCommit ?? 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})
	return { packageId: id, sourceId }
}

async function createHarness() {
	const db = await createShareDb()
	await enablePackageShareGrantsForTests(db.admin)
	await insertUser(db, {
		username: 'alice',
		email: 'alice@example.com',
		userId: ownerUserId,
		plan: 'standard',
	})
	await insertUser(db, {
		username: 'jesse',
		email: 'jesse@example.com',
		userId: guestUserId,
		plan: 'standard',
	})
	await insertUser(db, {
		username: 'freeuser',
		email: 'free@example.com',
		userId: freeUserId,
		plan: 'free',
	})
	const seeded = await seedPublishedPackage(db, {
		userId: ownerUserId,
		name: '@alice/shared-notes',
		kodyId: 'shared-notes',
	})
	return Object.assign(db, seeded)
}

function countingDb(db: SqlDatabase | ReturnType<ShareDb['as']>) {
	const statements: Array<string> = []
	const reads = { inFlight: 0, maxInFlight: 0 }
	const counted = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					statements.push(query.replace(/\s+/g, ' ').trim())
					const statement = target.prepare(query)
					return {
						bind: (...values: Array<unknown>) => {
							const bound = statement.bind(...values)
							return {
								async first<T>() {
									reads.inFlight += 1
									reads.maxInFlight = Math.max(
										reads.maxInFlight,
										reads.inFlight,
									)
									await new Promise((resolve) => setTimeout(resolve, 5))
									reads.inFlight -= 1
									return bound.first<T>()
								},
							}
						},
					}
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
	return { db: counted, statements, reads }
}

test('execute storage grant checks skip empty sets and verify ownership concurrently', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const second = await seedPublishedPackage(db, {
		userId: ownerUserId,
		name: '@alice/second',
		kodyId: 'second',
	})
	const counting = countingDb(db.as(ownerUserId))

	await expect(
		collectShareStorageOwners({
			db: counting.db,
			callerUserId: ownerUserId,
			packageIds: [],
		}),
	).resolves.toEqual(new Map())
	expect(counting.statements).toEqual([])

	const retained = await retainAuthorizedPackageStorageGrantIds({
		db: counting.db,
		callerUserId: ownerUserId,
		packageIds: [packageId, second.packageId, 'not-mine'],
		storageOwnerByPackageId: new Map(),
	})
	expect(retained).toEqual(new Set([packageId, second.packageId]))
	expect(counting.reads.maxInFlight).toBe(3)
})

test('invite fails closed when package-share-grants is off', async () => {
	await using db = await createShareDb()
	await insertUser(db, {
		username: 'alice',
		email: 'alice@example.com',
		userId: ownerUserId,
		plan: 'standard',
	})
	const seeded = await seedPublishedPackage(db, {
		userId: ownerUserId,
		name: '@alice/shared-notes',
		kodyId: 'shared-notes',
	})
	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner: {
				userId: ownerUserId,
				email: 'alice@example.com',
				displayName: 'Alice',
				username: 'alice',
			},
			packageId: seeded.packageId,
			invitee: { username: 'jesse' },
		}),
	).rejects.toThrow('Package sharing is not enabled for this account.')
})

test('turning package-share-grants off cuts accepted runtime access', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const guest = {
		userId: guestUserId,
		email: 'jesse@example.com',
		displayName: 'Jesse',
		username: 'jesse',
	}
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db: db.as(guestUserId),
		guest,
		grantId: invited.id,
	})
	await disablePackageShareGrantsForTests(db.admin)

	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()
	await expect(
		authorizeSharedPackagePermission({
			db: db.as(guestUserId),
			packageId,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			permission: 'invoke',
		}),
	).resolves.toBeNull()
	await expect(
		listAcceptedInboundSharedPackages({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
		}),
	).resolves.toEqual([])
	await expect(
		collectShareStorageOwners({
			db: db.as(guestUserId),
			callerUserId: guestUserId,
			packageIds: [packageId],
		}),
	).resolves.toEqual(new Map())
	await expect(
		listInboundPackageShareGrants(db.as(guestUserId), {
			userId: guestUserId,
			email: guest.email,
			emailVerified: true,
		}),
	).resolves.toEqual([])
	await expect(
		listOutboundPackageShareGrants(db.as(ownerUserId), ownerUserId),
	).resolves.toEqual([])
	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner,
			packageId,
			invitee: { username: 'freeuser' },
		}),
	).rejects.toThrow('Package sharing is not enabled for this account.')
})

test('invite, accept, revoke, and leave follow paid and accept-required rules', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const guest = {
		userId: guestUserId,
		email: 'jesse@example.com',
		displayName: 'Jesse',
		username: 'jesse',
	}

	await expect(
		invitePackageShare({
			db: db.as(freeUserId),
			owner: { ...owner, userId: freeUserId, email: 'free@example.com' },
			packageId,
			invitee: { username: 'jesse' },
		}),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)

	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	expect(invited.status).toBe('pending')
	expect(invited.granteeUserId).toBe(guestUserId)
	expect(invited.inviteeEmail).toBeNull()
	expect(invited.inviteeUsername).toBe('jesse')

	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner,
			packageId,
			invitee: { email: 'jesse@example.com' },
		}),
	).rejects.toThrow('already pending')

	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()

	const accepted = await acceptPackageShare({
		db: db.as(guestUserId),
		guest,
		grantId: invited.id,
	})
	expect(accepted.status).toBe('accepted')
	expect(accepted.trustLevel).toBe('pin')
	expect(accepted.acceptedPublishedCommit).toBe('commit-1')

	const resolved = await resolveShareGrantedPackageImport({
		db: db.as(guestUserId),
		granteeUserId: guestUserId,
		granteeEmail: guest.email,
		packageName: '@alice/shared-notes',
	})
	expect(resolved?.row.id).toBe(packageId)
	expect(resolved?.sourceOwnerUserId).toBe(ownerUserId)

	expect(
		await isShareGrantedForeignPackage({
			db: db.as(guestUserId),
			callerUserId: guestUserId,
			packageId,
		}),
	).toBe(true)
	expect(
		await resolvePackageStorageOwnerUserId({
			db: db.as(guestUserId),
			callerUserId: guestUserId,
			packageId,
		}),
	).toBe(ownerUserId)
	const shareOwners = await collectShareStorageOwners({
		db: db.as(guestUserId),
		callerUserId: guestUserId,
		packageIds: [packageId],
	})
	expect(shareOwners.get(packageId)).toBe(ownerUserId)
	expect(
		await retainAuthorizedPackageStorageGrantIds({
			db: db.as(guestUserId),
			callerUserId: guestUserId,
			packageIds: [packageId],
			storageOwnerByPackageId: shareOwners,
		}),
	).toEqual(new Set([packageId]))
	expect(
		await retainAuthorizedPackageStorageGrantIds({
			db: db.as(guestUserId),
			callerUserId: guestUserId,
			packageIds: [packageId],
			storageOwnerByPackageId: new Map(),
		}),
	).toEqual(new Set())

	const sourceRead = await authorizeSharedPackagePermission({
		db: db.as(guestUserId),
		packageId,
		granteeUserId: guestUserId,
		granteeEmail: guest.email,
		permission: 'read_source',
	})
	expect(sourceRead?.savedPackage.id).toBe(packageId)
	await expect(
		authorizeSharedPackagePermission({
			db: db.as(guestUserId),
			packageId,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			permission: 'publish',
		}),
	).resolves.toBeNull()

	const revoked = await revokePackageShare({
		db: db.as(ownerUserId),
		ownerUserId,
		grantId: invited.id,
	})
	expect(revoked.status).toBe('revoked')
	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()

	const reinvited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db: db.as(guestUserId),
		guest,
		grantId: reinvited.id,
	})
	const left = await leavePackageShare({
		db: db.as(guestUserId),
		granteeUserId: guestUserId,
		grantId: reinvited.id,
	})
	expect(left.status).toBe('left')
})

test('pin fails closed when the owner publishes ahead; follow does not', async () => {
	await using db = await createHarness()
	const { packageId, sourceId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const guest = {
		userId: guestUserId,
		email: 'jesse@example.com',
		displayName: 'Jesse',
		username: 'jesse',
	}
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db: db.as(guestUserId),
		guest,
		grantId: invited.id,
		trustLevel: 'pin',
	})
	await db.sql(
		`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
		'commit-2',
		sourceId,
	)

	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).rejects.toBeInstanceOf(PackageSharePinAheadError)

	await expect(
		acknowledgePackageShareUpdate({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			grantId: invited.id,
		}),
	).rejects.toMatchObject({
		message: 'Pin approval must name the published commit that was reviewed.',
	})
	await expect(
		acknowledgePackageShareUpdate({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			grantId: invited.id,
			expectedPublishedCommit: 'commit-stale',
		}),
	).rejects.toMatchObject({
		message:
			'The published package changed since this review. Reload and approve the current commit.',
	})

	const acknowledged = await acknowledgePackageShareUpdate({
		db: db.as(guestUserId),
		granteeUserId: guestUserId,
		grantId: invited.id,
		expectedPublishedCommit: 'commit-2',
	})
	expect(acknowledged.acceptedPublishedCommit).toBe('commit-2')
	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toMatchObject({ sourceOwnerUserId: ownerUserId })

	await acknowledgePackageShareUpdate({
		db: db.as(guestUserId),
		granteeUserId: guestUserId,
		grantId: invited.id,
		switchToFollow: true,
	})
	await db.sql(
		`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
		'commit-3',
		sourceId,
	)
	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toMatchObject({ sourceOwnerUserId: ownerUserId })
})

test('invite-before-signup attaches on account create without auto-accept', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'newguest@example.com' },
	})
	expect(invited.status).toBe('pending')
	expect(invited.granteeUserId).toBeNull()

	await db.sql(
		`UPDATE users SET email = ? WHERE stable_user_id = ?`,
		'newguest@example.com',
		guestUserId,
	)
	const attached = await attachPendingPackageShareInvitesForEmail({
		db: db.as(guestUserId),
		userId: guestUserId,
		email: 'newguest@example.com',
		username: 'jesse',
	})
	expect(attached.attached).toBe(1)
	const inbound = await listInboundPackageShareGrants(db.as(guestUserId), {
		userId: guestUserId,
		email: 'newguest@example.com',
	})
	expect(inbound[0]?.status).toBe('pending')
	expect(inbound[0]?.granteeUserId).toBe(guestUserId)
	await expect(
		resolveShareGrantedPackageImport({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()
})

test('both sides must stay paid to use a shared package', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	const accepted = await acceptPackageShare({
		db: db.as(guestUserId),
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
	})
	await db.sql(
		`UPDATE users SET plan = 'free' WHERE stable_user_id = ?`,
		guestUserId,
	)
	await expect(
		assertPackageShareUseAllowed({
			db: db.as(guestUserId),
			grant: accepted,
			savedPackage: {
				id: packageId,
				userId: ownerUserId,
				name: '@alice/shared-notes',
				kodyId: 'shared-notes',
				description: '',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: true,
				lockedAt: null,
				createdAt: '',
				updatedAt: '',
			},
			guest: { userId: guestUserId, email: 'jesse@example.com' },
		}),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)
})

test('outbound and inbound lists separate owner and guest views', async () => {
	await using db = await createHarness()
	const { packageId } = db
	await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	const outbound = await listOutboundPackageShareGrants(
		db.as(ownerUserId),
		ownerUserId,
	)
	expect(outbound).toHaveLength(1)
	expect(outbound[0]?.ownerUserId).toBe(ownerUserId)
	const inbound = await listInboundPackageShareGrants(db.as(guestUserId), {
		userId: guestUserId,
		email: 'jesse@example.com',
	})
	expect(inbound).toHaveLength(1)
	expect(inbound[0]?.inviteeEmail).toBeNull()
	expect(inbound[0]?.inviteeUsername).toBe('jesse')
})

test('username invites do not expose the invitee email to the owner', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	expect(invited.inviteeEmail).toBeNull()
	const views = await hydratePackageShareGrantViews(db.as(ownerUserId), [
		invited,
	])
	expect(views[0]?.inviteeEmail).toBeNull()
	expect(views[0]?.inviteeUsername).toBe('jesse')
})

test('a later owner of an invite email cannot steal a bound grant', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'steal@example.com' },
	})
	expect(invited.granteeUserId).toBeNull()
	await db.sql(
		`UPDATE users SET email = ? WHERE stable_user_id = ?`,
		'steal@example.com',
		guestUserId,
	)
	await attachPendingPackageShareInvitesForEmail({
		db: db.as(guestUserId),
		userId: guestUserId,
		email: 'steal@example.com',
		username: 'jesse',
	})
	await db.sql(
		`UPDATE users SET email = ? WHERE stable_user_id = ?`,
		'jesse-released@example.com',
		guestUserId,
	)
	const attackerUserId = 'dd'.repeat(32)
	await insertUser(db, {
		username: 'attacker',
		email: 'steal@example.com',
		userId: attackerUserId,
		plan: 'standard',
	})
	const inbound = await listInboundPackageShareGrants(db.as(attackerUserId), {
		userId: attackerUserId,
		email: 'steal@example.com',
		emailVerified: true,
	})
	expect(inbound.some((grant) => grant.id === invited.id)).toBe(false)
	await expect(
		acceptPackageShare({
			db: db.as(attackerUserId),
			guest: {
				userId: attackerUserId,
				email: 'steal@example.com',
				displayName: 'Attacker',
				username: 'attacker',
			},
			grantId: invited.id,
		}),
		// RLS hides grants not addressed to the caller, so there is nothing to accept.
	).rejects.toThrow('No pending package share invitation was found for you.')
})

test('unverified email does not reveal unbound email invites', async () => {
	await using db = await createHarness()
	const { packageId } = db
	await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'unverified@example.com' },
	})
	const inbound = await listInboundPackageShareGrants(db.as(guestUserId), {
		userId: guestUserId,
		email: 'unverified@example.com',
		emailVerified: false,
	})
	expect(inbound).toHaveLength(0)
})

test('hydrate skips grants whose saved package is gone', async () => {
	await using db = await createHarness()
	const { packageId } = db
	await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	await db.sql(`DELETE FROM saved_packages WHERE id = ?`, packageId)
	const outbound = await listOutboundPackageShareGrants(
		db.as(ownerUserId),
		ownerUserId,
	)
	expect(outbound).toHaveLength(1)
	expect(
		await hydratePackageShareGrantViews(db.as(ownerUserId), outbound),
	).toEqual([])
})

test('re-inviting an accepted email grant fails with a conflict, not a unique-index 500', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { email: 'jesse@example.com' },
	})
	await acceptPackageShare({
		db: db.as(guestUserId),
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
	})
	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner,
			packageId,
			invitee: { email: 'jesse@example.com' },
		}),
	).rejects.toThrow('already has an accepted share grant')
})

test('email invite of an unverified existing account stays unbound', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const unverifiedExistingId = 'ff'.repeat(32)
	await insertUser(db, {
		username: 'unverified-existing',
		email: 'unverified-existing@example.com',
		userId: unverifiedExistingId,
		plan: 'standard',
		emailVerified: false,
	})
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'unverified-existing@example.com' },
	})
	expect(invited.granteeUserId).toBeNull()
	const inbound = await listInboundPackageShareGrants(
		db.as(unverifiedExistingId),
		{
			userId: unverifiedExistingId,
			email: 'unverified-existing@example.com',
			emailVerified: false,
		},
	)
	expect(inbound).toHaveLength(0)
	await expect(
		acceptPackageShare({
			db: db.as(unverifiedExistingId),
			guest: {
				userId: unverifiedExistingId,
				email: 'unverified-existing@example.com',
				displayName: 'Unverified existing',
				username: 'unverified-existing',
			},
			grantId: invited.id,
		}),
		// RLS hides grants not addressed to the caller, so there is nothing to accept.
	).rejects.toThrow('No pending package share invitation was found for you.')
})

test('email invite of an unverified account conflicts with their username invite', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const unverifiedExistingId = '22'.repeat(32)
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	await insertUser(db, {
		username: 'unverified-named',
		email: 'unverified-named@example.com',
		userId: unverifiedExistingId,
		plan: 'standard',
		emailVerified: false,
	})
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'unverified-named' },
	})
	expect(invited.granteeUserId).toBe(unverifiedExistingId)
	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner,
			packageId,
			invitee: { email: 'unverified-named@example.com' },
		}),
	).rejects.toThrow('already pending')
})

test('username invite conflicts with an unbound pending email invite for that person', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { email: 'later-jesse@example.com' },
	})
	const laterUserId = '11'.repeat(32)
	await insertUser(db, {
		username: 'later-jesse',
		email: 'later-jesse@example.com',
		userId: laterUserId,
		plan: 'standard',
	})
	await expect(
		invitePackageShare({
			db: db.as(ownerUserId),
			owner,
			packageId,
			invitee: { username: 'later-jesse' },
		}),
	).rejects.toThrow('already pending')
})

test('unverified email cannot attach or accept an unbound invite', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { email: 'unverified-claim@example.com' },
	})
	const attackerUserId = 'ee'.repeat(32)
	await insertUser(db, {
		username: 'unverified',
		email: 'unverified-claim@example.com',
		userId: attackerUserId,
		plan: 'standard',
		emailVerified: false,
	})
	const attached = await attachPendingPackageShareInvitesForEmail({
		db: db.as(attackerUserId),
		userId: attackerUserId,
		email: 'unverified-claim@example.com',
		username: 'unverified',
	})
	expect(attached.attached).toBe(0)
	expect(invited.granteeUserId).toBeNull()
	expect(
		grantIsAddressedToGuest(
			invited,
			attackerUserId,
			'unverified-claim@example.com',
			false,
		),
	).toBe(false)
	await expect(
		acceptPackageShare({
			db: db.as(attackerUserId),
			guest: {
				userId: attackerUserId,
				email: 'unverified-claim@example.com',
				displayName: 'Unverified',
				username: 'unverified',
			},
			grantId: invited.id,
		}),
		// RLS hides grants not addressed to the caller, so there is nothing to accept.
	).rejects.toThrow('No pending package share invitation was found for you.')
})

test('search skips pin-ahead shared packages until the guest approves', async () => {
	await using db = await createHarness()
	const { packageId, sourceId } = db
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db: db.as(guestUserId),
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
		trustLevel: 'pin',
	})
	expect(
		await listAcceptedInboundSharedPackages({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
		}),
	).toHaveLength(1)
	await db.sql(
		`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
		'commit-ahead',
		sourceId,
	)
	expect(
		await listAcceptedInboundSharedPackages({
			db: db.as(guestUserId),
			granteeUserId: guestUserId,
		}),
	).toHaveLength(0)
})

test('only the grant parties see a shared package, and guests never read owner credentials', async () => {
	await using db = await createHarness()
	const { packageId } = db
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const ownerPackage = (userId: string) =>
		getSavedPackageById(db.as(userId), { userId: ownerUserId, packageId })

	await expect(ownerPackage(guestUserId)).resolves.toBeNull()
	await expect(
		findSharePeer(db.as(guestUserId), ownerUserId),
	).resolves.toBeNull()
	const invited = await invitePackageShare({
		db: db.as(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	// A pending invite lets the guest preview the package; outsiders see nothing.
	await expect(ownerPackage(guestUserId)).resolves.toMatchObject({
		id: packageId,
	})
	await expect(ownerPackage(freeUserId)).resolves.toBeNull()
	await expect(
		findSharePeer(db.as(freeUserId), ownerUserId),
	).resolves.toBeNull()
	// Owners reach their grantee's delivery email; guests get the owner's
	// username only, and no account columns through their own role.
	await expect(
		findSharePeer(db.as(ownerUserId), guestUserId),
	).resolves.toMatchObject({
		username: 'jesse',
		email: 'jesse@example.com',
	})
	await expect(
		findSharePeer(db.as(guestUserId), ownerUserId),
	).resolves.toMatchObject({
		username: 'alice',
		email: null,
	})
	const credentials = await db
		.as(guestUserId)
		.prepare('SELECT password_hash, email FROM users WHERE stable_user_id = ?')
		.bind(ownerUserId)
		.all()
	expect(credentials.results).toEqual([])

	await revokePackageShare({
		db: db.as(ownerUserId),
		ownerUserId,
		grantId: invited.id,
	})
	await expect(ownerPackage(guestUserId)).resolves.toBeNull()
	// A guest cannot re-point a grant at themselves after revocation.
	await db
		.as(guestUserId)
		.prepare(`UPDATE package_share_grants SET status = 'accepted' WHERE id = ?`)
		.bind(invited.id)
		.run()
	await expect(ownerPackage(guestUserId)).resolves.toBeNull()
	// Nor forge a grant to someone else's package.
	await expect(
		db
			.as(guestUserId)
			.prepare(
				`INSERT INTO package_share_grants (
					id, package_id, owner_user_id, grantee_user_id, status, role, invited_at
				) VALUES ('forged', ?, ?, ?, 'accepted', 'use', 'now')`,
			)
			.bind(packageId, ownerUserId, guestUserId)
			.run(),
	).rejects.toThrow(/row-level security/)
	await expect(ownerPackage(guestUserId)).resolves.toBeNull()
})
