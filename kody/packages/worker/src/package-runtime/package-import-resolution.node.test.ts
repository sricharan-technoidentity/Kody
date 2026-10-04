import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test } from 'vitest'
import { collectPackageStorageGrantIds } from '#mcp/run-kody-registry.ts'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import {
	acceptPackageShare,
	invitePackageShare,
} from '#worker/package-registry/share-grants.ts'
import { enablePackageShareGrantsForTests } from '#worker/package-registry/share-flag.ts'
import { resolveSavedPackageImport } from './package-import-resolution.ts'

async function createHarness() {
	const sqlite = await createTestPg()

	const db = createPgDatabase({ connection: sqlite, role: 'kody_admin' })
	await enablePackageShareGrantsForTests(db)
	const platform = await createPlatformAccount({
		db,
		forUser: (userId) =>
			createPgDatabase({ connection: sqlite, role: 'kody_writer', userId }),
		email: 'kody@example.com',
		username: 'kody',
	})
	return {
		sqlite,
		db,
		forUser: (userId: string) =>
			createPgDatabase({ connection: sqlite, role: 'kody_writer', userId }),
		platformUserId: platform.stableUserId,
	}
}

async function seedPackage(
	pg: Awaited<ReturnType<typeof createTestPg>>,
	input: {
		userId: string
		name: string
		kodyId: string
		hidden?: boolean
		isPrivate?: boolean
	},
) {
	const db = createPgDatabase({
		connection: pg,
		role: 'kody_writer',
		userId: input.userId,
	})
	const id = crypto.randomUUID()
	await insertSavedPackage(db, {
		id,
		user_id: input.userId,
		name: input.name,
		kody_id: input.kodyId,
		description: `${input.name} test package`,
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		hidden: input.hidden ? 1 : 0,
		is_private: input.isPrivate ? 1 : 0,
	})
	return id
}

test('resolveSavedPackageImport resolves platform scopes, prefers caller copies, and rejects hidden or foreign packages', async () => {
	const { db, sqlite, forUser, platformUserId } = await createHarness()
	const platformPackageId = await seedPackage(sqlite, {
		userId: platformUserId,
		name: '@kody/github',
		kodyId: 'github',
	})
	const personPackageId = await seedPackage(sqlite, {
		userId: 'caller-user',
		name: '@kentcdodds/github',
		kodyId: 'github',
	})

	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser('caller-user'),
			userId: 'caller-user',
			specifier: 'kody:@kody/github/issues',
		}),
	).resolves.toBeNull()
	const platformResolved = await resolveSavedPackageImport({
		forUser,
		db: forUser('caller-user'),
		userId: 'caller-user',
		specifier: 'kody:@kody/github/issues',
		allowPlatformScopes: true,
	})
	expect(platformResolved).toMatchObject({
		sourceOwnerUserId: platformUserId,
		platformScope: 'kody',
	})
	expect(platformResolved?.row.id).toBe(platformPackageId)
	const personResolved = await resolveSavedPackageImport({
		forUser,
		db: forUser('caller-user'),
		userId: 'caller-user',
		specifier: 'kody:@kentcdodds/github',
	})
	expect(personResolved).toMatchObject({
		sourceOwnerUserId: 'caller-user',
		platformScope: null,
	})
	expect(personResolved?.row.id).toBe(personPackageId)

	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser('caller-user'),
			userId: 'caller-user',
			specifier: 'kody:@kody/github',
			allowPlatformScopes: false,
		}),
	).resolves.toBeNull()

	const ownCopyId = await seedPackage(sqlite, {
		userId: 'copy-user',
		name: '@kody/github',
		kodyId: 'github',
	})
	const callerResolved = await resolveSavedPackageImport({
		forUser,
		db: forUser('copy-user'),
		userId: 'copy-user',
		specifier: 'kody:@kody/github',
	})
	expect(callerResolved).toMatchObject({
		sourceOwnerUserId: 'copy-user',
		platformScope: null,
	})
	expect(callerResolved?.row.id).toBe(ownCopyId)

	await seedPackage(sqlite, {
		userId: platformUserId,
		name: '@kody/wip-package',
		kodyId: 'wip-package',
		hidden: true,
	})
	await seedPackage(sqlite, {
		userId: platformUserId,
		name: '@kody/internal-package',
		kodyId: 'internal-package',
		isPrivate: true,
	})
	await seedPackage(sqlite, {
		userId: 'someone-else',
		name: '@someoneelse/tools',
		kodyId: 'tools',
	})
	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser('caller-user'),
			userId: 'caller-user',
			specifier: 'kody:@kody/wip-package',
			allowPlatformScopes: true,
		}),
	).resolves.toBeNull()
	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser('caller-user'),
			userId: 'caller-user',
			specifier: 'kody:@kody/internal-package',
			allowPlatformScopes: true,
		}),
	).resolves.toBeNull()
	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser('caller-user'),
			userId: 'caller-user',
			specifier: 'kody:@someoneelse/tools',
		}),
	).resolves.toBeNull()
})

test('platform-owned dependencies are excluded from packageStorage grants', () => {
	const granted = collectPackageStorageGrantIds({
		packageContext: { packageId: 'own-package-id', kodyId: 'own' } as never,
		dependencies: [
			{
				sourceId: 's1',
				publishedCommit: 'c1',
				kodyId: 'dep',
				packageId: 'own-dep-id',
			},
			{
				sourceId: 's2',
				publishedCommit: 'c2',
				kodyId: 'github',
				packageId: 'platform-dep-id',
				platformOwned: true,
			},
		],
		dynamicDependencyPackageIds: ['dynamic-dep-id'],
	})
	expect([...granted].sort()).toEqual([
		'dynamic-dep-id',
		'own-dep-id',
		'own-package-id',
	])
})

test('resolveSavedPackageImport resolves accepted share grants and not pending ones', async () => {
	const { db, sqlite, forUser } = await createHarness()
	const ownerUserId = 'aa'.repeat(32)
	const guestUserId = 'bb'.repeat(32)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, ?)`,
		)
		.bind('alice', 'alice@example.com', ownerUserId, 'standard')
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, ?)`,
		)
		.bind('jesse', 'jesse@example.com', guestUserId, 'standard')
		.run()
	const packageId = await seedPackage(sqlite, {
		userId: ownerUserId,
		name: '@alice/shared-notes',
		kodyId: 'shared-notes',
		isPrivate: true,
	})
	await insertEntitySource(forUser(ownerUserId), {
		id: `source-${packageId}`,
		user_id: ownerUserId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: `repo-${packageId}`,
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	})
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
	await invitePackageShare({
		db: forUser(ownerUserId),
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await expect(
		resolveSavedPackageImport({
			forUser,
			db: forUser(guestUserId),
			userId: guestUserId,
			specifier: 'kody:@alice/shared-notes/notes',
		}),
	).resolves.toBeNull()
	await acceptPackageShare({
		db: forUser(guestUserId),
		guest,
		packageId,
		trustLevel: 'follow',
	})
	const resolved = await resolveSavedPackageImport({
		forUser,
		db: forUser(guestUserId),
		userId: guestUserId,
		specifier: 'kody:@alice/shared-notes/notes',
	})
	expect(resolved).toMatchObject({
		sourceOwnerUserId: ownerUserId,
		shareOwned: true,
		storageOwnerUserId: ownerUserId,
	})
	expect(resolved?.row.id).toBe(packageId)
})

test('nested shared imports prefer the owner package over the guest name collision', async () => {
	const { db, sqlite, forUser } = await createHarness()
	const ownerUserId = 'aa'.repeat(32)
	const guestUserId = 'bb'.repeat(32)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, ?)`,
		)
		.bind('alice', 'alice@example.com', ownerUserId, 'standard')
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, ?)`,
		)
		.bind('jesse', 'jesse@example.com', guestUserId, 'standard')
		.run()
	const ownerHelperId = await seedPackage(sqlite, {
		userId: ownerUserId,
		name: '@alice/helper',
		kodyId: 'helper',
		isPrivate: true,
	})
	const guestHelperId = await seedPackage(sqlite, {
		userId: guestUserId,
		name: '@alice/helper',
		kodyId: 'helper',
		isPrivate: true,
	})
	const resolved = await resolveSavedPackageImport({
		forUser,
		db: forUser(guestUserId),
		userId: guestUserId,
		specifier: 'kody:@alice/helper',
		nestedShareOwnerUserId: ownerUserId,
	})
	expect(resolved?.row.id).toBe(ownerHelperId)
	expect(resolved?.shareOwned).toBe(true)
	expect(resolved?.storageOwnerUserId).toBe(ownerUserId)
	expect(guestHelperId).not.toBe(ownerHelperId)
})
