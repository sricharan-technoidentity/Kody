import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { assertAccountAccess } from './isolation.ts'

test('user isolation holds across SQL, KV, S3 and KMS; blocked accounts cannot enter any surface', async () => {
	const { env, close } = await createTargetTestEnv({ userId: 'alice' })
	try {
		await env.pg.query('INSERT INTO isolation_probe VALUES ($1, $2, $3)', [
			'bob-row',
			'bob',
			'private',
		])
		expect(
			await env.db
				.prepare('SELECT value FROM isolation_probe WHERE id = ?')
				.bind('bob-row')
				.first(),
		).toBeNull()
		expect(() => env.kv.get('bob:runs', 'one')).toThrow('cross-user')
		expect(() => env.objects.get('bob/private')).toThrow('cross-user')
		const secret = await env.kms.encrypt(new TextEncoder().encode('private'), {
			userId: 'alice',
		})
		await expect(
			env.kms.decrypt(secret, { userId: 'bob' }),
		).rejects.toBeInstanceOf(Error)
		await assertAccountAccess({
			env,
			userId: 'alice',
			surface: 'front-door',
			account: { verified: true, suspended: false },
		})
		for (const surface of ['front-door', 'broker', 'egress'] as const) {
			await expect(
				assertAccountAccess({
					env,
					userId: 'alice',
					surface,
					account: { verified: false, suspended: false },
				}),
			).rejects.toBeInstanceOf(Error)
			await expect(
				assertAccountAccess({
					env,
					userId: 'alice',
					surface,
					account: { verified: true, suspended: true },
				}),
			).rejects.toBeInstanceOf(Error)
		}
	} finally {
		await close()
	}
})

test('Postgres acceptance isolates application rows, integer-owned credentials and child secrets', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	const { pg, db, reader } = database
	await pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash) VALUES (1, 'alice', 'alice@example.test', 'alice', 'x'), (2, 'bob', 'bob@example.test', 'bob', 'x')`,
	)
	await pg.query(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bob-bucket', 'bob', 'user', 'default')`,
	)
	await pg.query(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bob-bucket', 'token', 'secret')`,
	)
	await database
		.forUser('bob')
		.db.prepare(
			"INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('bob-row', 'bob', 'private', 'private')",
		)
		.run()
	await db
		.prepare(
			"INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('alice-row', 'alice', 'notes', 'notes')",
		)
		.run()
	expect(
		(await reader.prepare('SELECT id FROM mcp_memories').all()).results,
	).toEqual([{ id: 'alice-row' }])
	expect(
		(await reader.prepare('SELECT username FROM users').all()).results,
	).toEqual([{ username: 'alice' }])
	expect(
		(await reader.prepare('SELECT * FROM secret_entries').all()).results,
	).toEqual([])
	await expect(
		db.prepare("UPDATE mcp_memories SET user_id = 'bob'").run(),
	).rejects.toThrow('row-level security')
	await expect(
		db
			.prepare(
				"INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bob-bucket', 'other', 'bad')",
			)
			.run(),
	).rejects.toThrow('row-level security')
	await expect(
		reader.prepare('DELETE FROM mcp_memories').run(),
	).rejects.toThrow('read-only transaction')
	expect(
		(
			await database
				.forUser()
				.reader.prepare('SELECT * FROM mcp_memories')
				.all()
		).results,
	).toEqual([])
})
