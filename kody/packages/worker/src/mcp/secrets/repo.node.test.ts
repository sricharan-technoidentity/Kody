import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { type PGlite } from '@electric-sql/pglite'
import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	listPackageScopeSecretMetadata,
	listSecretBucketsByScope,
} from './repo.ts'

async function insertPackageSecret(
	pg: PGlite,
	input: {
		bucketId: string
		userId: string
		packageId: string
		name: string
	},
) {
	await pg.query(
		`INSERT INTO secret_buckets (
			id, user_id, scope, binding_key, created_at, updated_at
		) VALUES ($1, $2, 'package', $3, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		[input.bucketId, input.userId, input.packageId],
	)
	await pg.query(
		`INSERT INTO secret_entries (
			bucket_id, name, description, encrypted_value,
			allowed_hosts, allowed_packages,
			created_at, updated_at
		) VALUES ($1, $2, '', 'ciphertext', '[]', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		[input.bucketId, input.name],
	)
}

test('listPackageScopeSecretMetadata chunks package ids to stay within the D1 binding limit', async () => {
	const userId = 'user-with-many-packages'
	await using database = await createTestDb({ userId })
	const db = database.reader as unknown as SqlDatabase
	const packageIds = Array.from(
		{ length: maxD1BoundParameters + 1 },
		(_, index) => `package-${String(index).padStart(3, '0')}`,
	)
	await insertPackageSecret(database.pg, {
		bucketId: 'bucket-first',
		userId,
		packageId: packageIds[0] ?? 'package-000',
		name: 'alpha-token',
	})
	await insertPackageSecret(database.pg, {
		bucketId: 'bucket-last',
		userId,
		packageId: packageIds.at(-1) ?? 'package-100',
		name: 'zeta-token',
	})

	const rows = await listPackageScopeSecretMetadata({
		db,
		userId,
		packageIds,
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(rows).toEqual([
		expect.objectContaining({
			name: 'alpha-token',
			binding_key: 'package-000',
			scope: 'package',
		}),
		expect.objectContaining({
			name: 'zeta-token',
			binding_key: 'package-100',
			scope: 'package',
		}),
	])
})

test('listSecretBucketsByScope returns caller-owned package buckets only (RLS and the user filter)', async () => {
	await using database = await createTestDb({ userId: 'user-1' })
	const db = database.reader as unknown as SqlDatabase
	await insertPackageSecret(database.pg, {
		bucketId: 'bucket-owned',
		userId: 'user-1',
		packageId: 'package-owned',
		name: 'owned-token',
	})
	await insertPackageSecret(database.pg, {
		bucketId: 'bucket-other',
		userId: 'user-2',
		packageId: 'package-other',
		name: 'other-token',
	})

	const buckets = await listSecretBucketsByScope({
		db,
		userId: 'user-1',
		scope: 'package',
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(buckets).toEqual([
		expect.objectContaining({
			user_id: 'user-1',
			scope: 'package',
			binding_key: 'package-owned',
		}),
	])
})
