import { expect, test, vi } from 'vitest'
import { insertCommunityFork } from '#worker/community/repo.ts'
import { resolveViewerListingInstalls } from '#worker/community/viewer-install.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const mockModule = vi.hoisted(() => ({
	cleanupArtifactReposForPackage: vi.fn(),
	deleteEntitySource: vi.fn(),
	deleteJobRow: vi.fn(),
	listJobRowsByUserId: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
	deleteSavedPackageVector: vi.fn(),
	removePackageRetrieverManifestCacheEntries: vi.fn(),
	deleteAllAppScopedValues: vi.fn(),
	deleteAllPackageScopedSecrets: vi.fn(),
	removeAllSecretApprovalsForPackage: vi.fn(),
	clearStorage: vi.fn(async () => ({ ok: true as const })),
	storageRunnerRpc: vi.fn(),
	unpublishCommunityListing: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		storageRunnerRpc: (...args: Array<unknown>) => {
			mockModule.storageRunnerRpc(...args)
			return {
				clearStorage: (...clearArgs: Array<unknown>) =>
					mockModule.clearStorage(...clearArgs),
			}
		},
	}
})

vi.mock('#worker/package-config-cleanup.ts', () => ({
	deleteAllAppScopedValues: (...args: Array<unknown>) =>
		mockModule.deleteAllAppScopedValues(...args),
	deleteAllPackageScopedSecrets: (...args: Array<unknown>) =>
		mockModule.deleteAllPackageScopedSecrets(...args),
	removeAllSecretApprovalsForPackage: (...args: Array<unknown>) =>
		mockModule.removeAllSecretApprovalsForPackage(...args),
}))

vi.mock('#worker/package-retrievers/manifest-cache.ts', () => ({
	removePackageRetrieverManifestCacheEntries: (...args: Array<unknown>) =>
		mockModule.removePackageRetrieverManifestCacheEntries(...args),
	refreshPackageRetrieverManifestCache: vi.fn(),
}))

vi.mock('./vectorize.ts', () => ({
	deleteSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackageVector(...args),
	upsertSavedPackageVector: vi.fn(),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		deleteJob: (...args: Array<unknown>) => mockModule.deleteJobRow(...args),
		listJobsForUser: (...args: Array<unknown>) =>
			mockModule.listJobRowsByUserId(...args),
	}),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
}))

vi.mock('#worker/repo/artifact-repo-cleanup.ts', () => ({
	cleanupArtifactReposForPackage: (...args: Array<unknown>) =>
		mockModule.cleanupArtifactReposForPackage(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	unpublishCommunityListing: (...args: Array<unknown>) =>
		mockModule.unpublishCommunityListing(...args),
}))

vi.mock('#worker/community/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getCommunityListingByOwnerAndPackage: vi.fn(async () => null),
	}
})

const { deleteSavedPackageProjection } = await import('./service.ts')

const listingRef = {
	id: 'listing-plaid',
	kodyId: 'plaid',
	pinnedCommit: 'commit-new',
}

test('package delete removes community_forks so Fork outdated does not linger', async () => {
	await using database = await createTestDb()
	// The delete runs as kent; fixtures and assertions use the schema owner.
	const db = database.forUser('user-kent').db
	const pg = database.pg
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METERS: meter.env.USER_METERS,
	} as unknown as Env
	await pg.query(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('kentcdodds', 'kent@example.com', 'x', 'user-kent')`,
	)
	await pg.query(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, manifest_path, source_root, created_at, updated_at
		) VALUES
			('source-live', 'user-kent', 'package', 'package-live', 'repo-live', 'package.json', '/', 'now', 'now'),
			('source-inert', 'user-kent', 'package', 'package-inert', 'repo-inert', 'package.json', '/', 'now', 'now'),
			('source-other', 'user-other', 'package', 'package-other', 'repo-other', 'package.json', '/', 'now', 'now')`,
	)
	await pg.query(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id
		) VALUES (
			'package-live', 'user-kent', '@kentcdodds/plaid', 'plaid',
			'Kent copy', 'source-live'
		)`,
	)
	await insertCommunityFork(db, {
		id: 'fork-live',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-old',
		forked_package_id: 'package-live',
		forked_source_id: 'source-live',
		target_kody_id: 'plaid',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await insertCommunityFork(db, {
		id: 'fork-inert',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-old',
		forked_package_id: 'package-inert',
		forked_source_id: 'source-inert',
		target_kody_id: 'plaid-inert',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await insertCommunityFork(database.forUser('user-other').db, {
		id: 'fork-other',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-other',
		origin_commit: 'commit-old',
		forked_package_id: 'package-other',
		forked_source_id: 'source-other',
		target_kody_id: 'plaid',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})

	const beforeInstalls = resolveViewerListingInstalls({
		listings: [listingRef],
		packageScope: 'kentcdodds',
		savedPackages: [
			{
				id: 'package-live',
				kodyId: 'plaid',
				name: '@kentcdodds/plaid',
				sourceId: 'source-live',
			},
		],
		forks: [
			{
				listingId: 'listing-plaid',
				targetKodyId: 'plaid',
				forkedPackageId: 'package-live',
				forkedSourceId: 'source-live',
				createdAt: '2026-08-13T00:00:00.000Z',
				originCommit: 'commit-old',
			},
		],
		listingPinIsAncestorByListingId: new Map([['listing-plaid', false]]),
	})
	expect(beforeInstalls.get('listing-plaid')).toMatchObject({
		status: 'installed',
		listingAhead: true,
		packageId: 'package-live',
	})

	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.deleteEntitySource.mockResolvedValue(true)
	mockModule.listJobRowsByUserId.mockResolvedValue([])
	mockModule.deleteSavedPackageVector.mockResolvedValue(undefined)
	mockModule.removePackageRetrieverManifestCacheEntries.mockResolvedValue(
		undefined,
	)
	mockModule.deleteAllAppScopedValues.mockResolvedValue(undefined)
	mockModule.deleteAllPackageScopedSecrets.mockResolvedValue(undefined)
	mockModule.removeAllSecretApprovalsForPackage.mockResolvedValue(undefined)

	await deleteSavedPackageProjection({
		env,
		userId: 'user-kent',
		packageId: 'package-live',
	})

	const remaining = {
		results: (
			await pg.query<{
				id: string
				forker_user_id: string
				forked_package_id: string
			}>(
				`SELECT id, forker_user_id, forked_package_id FROM community_forks
				ORDER BY id`,
			)
		).rows,
	}
	expect(remaining.results).toEqual([
		{
			id: 'fork-inert',
			forker_user_id: 'user-kent',
			forked_package_id: 'package-inert',
		},
		{
			id: 'fork-other',
			forker_user_id: 'user-other',
			forked_package_id: 'package-other',
		},
	])
	expect(
		(await pg.query(`SELECT id FROM saved_packages WHERE id = 'package-live'`))
			.rows,
	).toEqual([])

	const afterInstalls = resolveViewerListingInstalls({
		listings: [listingRef],
		packageScope: 'kentcdodds',
		savedPackages: [],
		forks: remaining.results
			.filter((row) => row.forker_user_id === 'user-kent')
			.map((row) => ({
				listingId: 'listing-plaid',
				targetKodyId: 'plaid-inert',
				forkedPackageId: row.forked_package_id,
				forkedSourceId: 'source-inert',
				createdAt: '2026-08-13T00:00:00.000Z',
				originCommit: 'commit-old',
			})),
		listingPinIsAncestorByListingId: new Map([['listing-plaid', false]]),
	})
	expect(afterInstalls.get('listing-plaid')).toMatchObject({
		status: 'adaptation_required',
		targetName: '@kentcdodds/plaid-inert',
		packageId: null,
	})
	const kentDeletedCopyForks = await db
		.prepare(
			`SELECT id FROM community_forks
			WHERE forker_user_id = 'user-kent'
				AND listing_id = 'listing-plaid'
				AND (forked_package_id = 'package-live' OR target_kody_id = 'plaid')`,
		)
		.all<{ id: string }>()
	expect(kentDeletedCopyForks.results).toEqual([])
	const afterDeletedCopyOnly = resolveViewerListingInstalls({
		listings: [listingRef],
		packageScope: 'kentcdodds',
		savedPackages: [],
		forks: kentDeletedCopyForks.results.map((row) => ({
			listingId: 'listing-plaid',
			targetKodyId: listingRef.kodyId,
			forkedPackageId: row.id,
			forkedSourceId: row.id,
			createdAt: '2026-08-13T00:00:00.000Z',
			originCommit: 'commit-old',
		})),
		listingPinIsAncestorByListingId: new Map([['listing-plaid', false]]),
	})
	expect(afterDeletedCopyOnly.has('listing-plaid')).toBe(false)

	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (
				'package-trigger', 'user-kent', '@kentcdodds/plaid-trigger',
				'plaid-trigger', 'Trigger copy', 'source-trigger'
			)`,
		)
		.run()
	await insertCommunityFork(db, {
		id: 'fork-trigger-package',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-old',
		forked_package_id: 'package-trigger',
		forked_source_id: 'source-trigger',
		target_kody_id: 'plaid-trigger',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await db
		.prepare(`DELETE FROM saved_packages WHERE id = 'package-trigger'`)
		.run()
	expect(
		await db
			.prepare(
				`SELECT id FROM community_forks WHERE id = 'fork-trigger-package'`,
			)
			.first(),
	).toBeNull()

	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, manifest_path, source_root, created_at, updated_at
			) VALUES ('source-trigger-2', 'user-kent', 'package', 'package-gone', 'repo-gone', 'package.json', '/', 'now', 'now')`,
		)
		.run()
	await insertCommunityFork(db, {
		id: 'fork-trigger-source',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-old',
		forked_package_id: 'package-gone',
		forked_source_id: 'source-trigger-2',
		target_kody_id: 'plaid-source',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await db
		.prepare(`DELETE FROM entity_sources WHERE id = 'source-trigger-2'`)
		.run()
	expect(
		await db
			.prepare(
				`SELECT id FROM community_forks WHERE id = 'fork-trigger-source'`,
			)
			.first(),
	).toBeNull()
})
