import { expect, test } from 'vitest'
import { removeAllSecretApprovalsForPackage } from '#worker/package-config-cleanup.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

test('removing a package drops it from the owner’s secret approvals only', async () => {
	await using store = await createTestDb()
	await store.pg.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES
			('owner-user', 'owner', 'user', 'owner'),
			('owner-package', 'owner', 'package', 'pkg-a'),
			('other-user', 'other', 'user', 'other');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value, allowed_packages) VALUES
			('owner-user', 'shared', 'x', '["pkg-a","pkg-b"]'),
			('owner-user', 'only-a', 'x', '["pkg-a"]'),
			('owner-user', 'unrelated', 'x', '["pkg-b"]'),
			('owner-user', 'corrupt', 'x', 'not json'),
			('owner-package', 'scoped', 'x', '["pkg-a"]'),
			('other-user', 'bystander', 'x', '["pkg-a"]');
	`)

	const changed = await removeAllSecretApprovalsForPackage({
		env: { APP_DB: store.forUser('owner').db } as unknown as Env,
		userId: 'owner',
		packageId: 'pkg-a',
	})

	expect(changed).toBe(2)
	const { rows } = await store.pg.query<{ name: string; allowed: unknown }>(
		`SELECT name, CASE WHEN pg_input_is_valid(allowed_packages, 'jsonb')
			THEN allowed_packages::jsonb ELSE to_jsonb(allowed_packages) END AS allowed
		 FROM secret_entries ORDER BY name`,
	)
	expect(rows).toEqual([
		{ name: 'bystander', allowed: ['pkg-a'] },
		{ name: 'corrupt', allowed: 'not json' },
		{ name: 'only-a', allowed: [] },
		{ name: 'scoped', allowed: ['pkg-a'] },
		{ name: 'shared', allowed: ['pkg-b'] },
		{ name: 'unrelated', allowed: ['pkg-b'] },
	])
})
