import { expect, test } from 'vitest'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createDb } from '#worker/db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { applyPasswordChange } from './apply-password-change.ts'

async function seedUserWithFactors() {
	const email = 'factors@example.com'
	const passwordHash = await createPasswordHash('old-password-ok')
	const stableUserId = await createStableUserIdFromEmail(email)
	const store = await createTestDb({ userId: stableUserId })
	await store.pg.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (1, 'factors', '${email}', '${stableUserId}', '${passwordHash}', '2026-01-01T00:00:00.000Z');
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'factors-github', 1, 'factors');
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (1, 'token-hash', ${Date.now() + 60_000});
	`)
	return { store, db: createDb(store.db), stableUserId, passwordHash }
}

const helpers = {
	listUserGrants: async () => ({ items: [] }),
	revokeGrant: async () => {},
} as never

test('a failed factor cleanup leaves the password, stamp, and reset token untouched', async () => {
	const { store, db, stableUserId, passwordHash } = await seedUserWithFactors()
	await using _store = store
	// Force the connection delete inside clearSecondFactorsAndConnections to
	// fail so the ordering guarantee is observable.
	await store.pg.exec(`REVOKE DELETE ON oauth_connections FROM kody_writer`)

	await expect(
		applyPasswordChange({
			db,
			d1: store.db,
			helpers,
			userId: 1,
			stableUserId,
			password: 'brand-new-password',
			clearSecondFactorsAndConnections: true,
		}),
	).rejects.toThrow(/permission denied/)

	expect(
		(
			await store.pg.query(
				`SELECT password_hash, password_changed_at FROM users WHERE id = 1`,
			)
		).rows,
	).toEqual([{ password_hash: passwordHash, password_changed_at: null }])
	expect(
		(await store.pg.query(`SELECT COUNT(*)::int AS count FROM password_resets`))
			.rows,
	).toEqual([{ count: 1 }])
})

test('factors are cleared before password_changed_at is stamped', async () => {
	const { store, db, stableUserId } = await seedUserWithFactors()
	await using _store = store
	// Observe the connection count at the moment the users row is stamped.
	await store.pg.exec(`
		CREATE TABLE stamp_markers (connections INTEGER NOT NULL);
		CREATE FUNCTION capture_connections_at_stamp() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER AS $fn$
		BEGIN
			INSERT INTO stamp_markers (connections) SELECT COUNT(*) FROM oauth_connections;
			RETURN NEW;
		END
		$fn$;
		CREATE TRIGGER capture_connections_at_stamp
		AFTER UPDATE OF password_changed_at ON users
		FOR EACH ROW EXECUTE FUNCTION capture_connections_at_stamp();
	`)

	const result = await applyPasswordChange({
		db,
		d1: store.db,
		helpers,
		userId: 1,
		stableUserId,
		password: 'brand-new-password',
		clearSecondFactorsAndConnections: true,
	})
	expect(result.ok).toBe(true)

	expect(
		(await store.pg.query(`SELECT connections FROM stamp_markers`)).rows,
	).toEqual([{ connections: 0 }])
	expect(
		(
			await store.pg.query(
				`SELECT COUNT(*)::int AS count FROM password_resets WHERE user_id = 1`,
			)
		).rows,
	).toEqual([{ count: 0 }])
})
