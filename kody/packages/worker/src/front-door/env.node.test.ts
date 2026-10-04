import { expect, test } from 'vitest'
import { createTestDb } from '../test-support/aws/test-db.ts'
import { createPgDatabase } from '../aws/pg-database.ts'
import { createStableUserIdFromEmail } from '../user-id.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { createAwsEnv } from './env.ts'

test('request cookies bind owner RLS, expired/password-reset sessions lose scope, and admin readers cannot write', async () => {
	await using target = await createTestDb()
	const alice = await createStableUserIdFromEmail('alice@example.com')
	const bob = await createStableUserIdFromEmail('bob@example.com')
	await target.pg.query(
		"INSERT INTO users (email, username, stable_user_id, password_hash) VALUES ('alice@example.com', 'alice', $1, 'hash'), ('bob@example.com', 'bob', $2, 'hash')",
		[alice, bob],
	)
	await target.pg.query(
		"INSERT INTO isolation_probe VALUES ('a', $1, 'Alice'), ('b', $2, 'private')",
		[alice, bob],
	)
	await target.pg.exec(
		"INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'alice' AND r.name = 'admin'",
	)
	const role = (
		name: Parameters<typeof createPgDatabase>[0]['role'],
		userId?: string,
		readOnly = false,
	) => createPgDatabase({ connection: target.pg, role: name, userId, readOnly })
	const secret = 'request-env-cookie-secret-0123456789abcdef'
	setAuthSessionSecret(secret)
	const issued = Date.now() - 1000
	const cookie = (
		await createAuthCookie(
			{ stableUserId: alice, email: 'alice@example.com', rememberMe: false },
			false,
			issued,
		)
	).split(';')[0]!
	const factory = createAwsEnv({
		bindings: { COOKIE_SECRET: secret } as Env,
		databases: {
			forUser: target.forUser,
			admin: role('kody_admin'),
			adminReader: role('kody_admin', undefined, true),
			community: role('kody_community'),
			analytics: role('kody_analytics'),
			indexer: role('kody_indexer'),
			subjectReader: (id) => role('kody_subject_reader', id),
			subjectPurger: (id) => role('kody_subject_purger', id),
		},
	})
	const request = new Request('https://kody.codes/account', {
		headers: { Cookie: cookie },
	})
	const owner = await factory.forRequest(request, false)
	expect(owner.REQUEST_USER_ID).toBe(alice)
	expect(
		(await owner.APP_DB.prepare('SELECT value FROM isolation_probe').all())
			.results,
	).toEqual([{ value: 'Alice' }])
	await expect(
		owner.APP_DB.prepare("UPDATE isolation_probe SET value = 'bad'").run(),
	).rejects.toThrow('read-only transaction')
	expect(() => owner.ACCOUNT_SUBJECT_READER!(bob)).toThrow('owner mismatch')
	expect(owner.ACCOUNT_SUBJECT_PURGER).toBeUndefined()
	expect(() =>
		factory.forUser(alice, true).ACCOUNT_SUBJECT_PURGER!(bob),
	).toThrow('owner mismatch')
	const operator = await factory.forRequest(
		new Request('https://kody.codes/admin', { headers: { Cookie: cookie } }),
		false,
	)
	await expect(
		operator.APP_DB.prepare('UPDATE site_banners SET enabled = 0').run(),
	).rejects.toThrow('read-only transaction')
	await target.pg.query(
		'UPDATE users SET password_changed_at = $1 WHERE stable_user_id = $2',
		[new Date().toISOString(), alice],
	)
	expect(
		(await factory.forRequest(request, true)).REQUEST_USER_ID,
	).toBeUndefined()
	const oldCookie = await createAuthCookie(
		{ stableUserId: bob, email: 'bob@example.com', rememberMe: false },
		false,
		issued - 8 * 86400000,
	)
	expect(
		(
			await factory.forRequest(
				new Request(request.url, {
					headers: { Cookie: oldCookie.split(';')[0]! },
				}),
				false,
			)
		).REQUEST_USER_ID,
	).toBeUndefined()
})
