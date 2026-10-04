import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { expect, test } from 'vitest'
import { getStaticPackageDependentsSummary } from '#worker/package-runtime/static-package-dependents.ts'

async function insertPackage(
	db: SqlDatabase,
	input: {
		userId: string
		packageId: string
		kodyId: string
		name: string
		sourceId: string
		publishedCommit: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		)
		.bind(
			input.packageId,
			input.userId,
			input.name,
			input.kodyId,
			`${input.name} package`,
			input.sourceId,
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		)
		.bind(
			input.sourceId,
			input.userId,
			input.packageId,
			`repo-${input.sourceId}`,
			input.publishedCommit,
			now,
			now,
		)
		.run()
}

async function insertArtifact(
	db: SqlDatabase,
	input: {
		userId: string
		sourceId: string
		publishedCommit: string
		artifactName: string
		entryPoint: string
		dependencies: Array<Record<string, unknown>>
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
			id, user_id, source_id, published_commit, artifact_kind, artifact_name,
			entry_point, kv_key, dependencies_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'module', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactName,
			input.entryPoint,
			`kv:${input.sourceId}:${input.artifactName}`,
			JSON.stringify(input.dependencies),
			now,
			now,
		)
		.run()
}

test('static dependent summary runs JSON dependency queries against PostgreSQL', async () => {
	const unique = crypto.randomUUID()
	const userId = `user-${unique}`
	await using database = await createTestDb({ userId })
	const db = database.db
	const sourceA = `source-a-${unique}`
	const sourceB = `source-b-${unique}`
	const sourceC = `source-c-${unique}`
	const sourceD = `source-d-${unique}`
	await insertPackage(db, {
		userId,
		packageId: `package-a-${unique}`,
		kodyId: `package-a-${unique}`,
		name: `@kentcdodds/package-a-${unique}`,
		sourceId: sourceA,
		publishedCommit: 'commit-a-new',
	})
	await insertPackage(db, {
		userId,
		packageId: `package-b-${unique}`,
		kodyId: `package-b-${unique}`,
		name: `@kentcdodds/package-b-${unique}`,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
	})
	await insertPackage(db, {
		userId,
		packageId: `package-c-${unique}`,
		kodyId: `package-c-${unique}`,
		name: `@kentcdodds/package-c-${unique}`,
		sourceId: sourceC,
		publishedCommit: 'commit-c',
	})
	await insertPackage(db, {
		userId,
		packageId: `package-d-${unique}`,
		kodyId: `package-d-${unique}`,
		name: `@kentcdodds/package-d-${unique}`,
		sourceId: sourceD,
		publishedCommit: 'commit-d-current',
	})
	for (let index = 0; index < 5; index += 1) {
		await insertArtifact(db, {
			userId,
			sourceId: sourceB,
			publishedCommit: 'commit-b',
			artifactName: `a-current-${index}`,
			entryPoint: `src/current-${index}.ts`,
			dependencies: [
				{
					sourceId: sourceA,
					publishedCommit: 'commit-a-new',
					kodyId: `package-a-${unique}`,
					packageName: `@kentcdodds/package-a-${unique}`,
				},
			],
		})
	}
	await insertArtifact(db, {
		userId,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
		artifactName: 'a-current-0-importable',
		entryPoint: 'src/current-0.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-new',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact(db, {
		userId,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
		artifactName: 'z-stale',
		entryPoint: 'src/stale.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-old',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact(db, {
		userId,
		sourceId: sourceC,
		publishedCommit: 'commit-c',
		artifactName: 'missing-commit',
		entryPoint: 'src/missing.ts',
		dependencies: [
			{
				sourceId: sourceA,
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact(db, {
		userId,
		sourceId: sourceD,
		publishedCommit: 'commit-d-obsolete',
		artifactName: 'removed-import',
		entryPoint: 'src/removed-import.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-old',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})

	const summary = await getStaticPackageDependentsSummary({
		db,
		userId,
		sourceId: sourceA,
		currentDependencyCommit: 'commit-a-new',
	})

	expect(summary).toEqual(
		expect.objectContaining({
			total: 2,
			stale: 2,
			truncated: false,
		}),
	)
	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-b-${unique}`,
			stale: true,
			artifact_count: 7,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)
	expect(summary.items[0]?.entrypoints).toHaveLength(5)
	expect(summary.items[0]?.entrypoints[0]).toBe('src/stale.ts')
	expect(summary.items[1]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-c-${unique}`,
			stale: true,
			bundled_dependency_commit: null,
		}),
	)
})
