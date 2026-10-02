import { expect, test } from 'vitest'
import { type Pool } from 'pg'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from './pg-database.ts'

test('application schema enforces stable and integer owner RLS, read-only transactions and atomic batches', async () => {
	const { pg, db, reader, forUser } = await createTestDb({ userId: 'alice' })
	try {
		await pg.query(`INSERT INTO users (id, username, email, stable_user_id, password_hash)
			VALUES (1, 'alice', 'alice@example.test', 'alice', 'x'), (2, 'bob', 'bob@example.test', 'bob', 'x')`)
		await db
			.prepare(
				'INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES (?, ?, ?, ?)',
			)
			.bind('one', 'alice', 'Alice', 'private')
			.run()
		await forUser('bob')
			.db.prepare(
				'INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES (?, ?, ?, ?)',
			)
			.bind('two', 'bob', 'Bob', 'secret')
			.run()
		expect(await db.prepare('SELECT subject FROM mcp_memories').raw()).toEqual([
			['Alice'],
		])
		expect(await reader.prepare('SELECT username FROM users').raw()).toEqual([
			['alice'],
		])
		await db
			.prepare(
				'INSERT INTO passkeys (id, aaguid, public_key, user_id, webauthn_user_handle, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(
				'a',
				'aaguid',
				'key',
				1,
				'handle',
				0,
				'singleDevice',
				0,
				'internal',
				'laptop',
			)
			.run()
		expect(
			await forUser('bob').db.prepare('SELECT id FROM passkeys').first(),
		).toBeNull()
		await expect(
			db.prepare('UPDATE passkeys SET user_id = 2').run(),
		).rejects.toThrow('row-level security')
		await expect(
			reader
				.prepare(
					'WITH changed AS (DELETE FROM mcp_memories RETURNING id) SELECT * FROM changed',
				)
				.all(),
		).rejects.toThrow('read-only transaction')
		await expect(
			reader.prepare('SELECT * FROM mcp_memories FOR UPDATE').all(),
		).rejects.toThrow('read-only transaction')
		await expect(
			db.batch([
				db
					.prepare(
						'INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES (?, ?, ?, ?)',
					)
					.bind('rollback', 'alice', 'x', 'x'),
				db
					.prepare(
						'INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES (?, ?, ?, ?)',
					)
					.bind('denied', 'bob', 'x', 'x'),
			]),
		).rejects.toThrow('row-level security')
		expect(
			await db
				.prepare("SELECT id FROM mcp_memories WHERE id = 'rollback'")
				.first(),
		).toBeNull()
		expect(
			await forUser('bob').reader.prepare('SELECT username FROM users').raw(),
		).toEqual([['bob']])
		const unscoped = createPgDatabase({ connection: pg, role: 'kody_writer' })
		expect(await unscoped.prepare('SELECT id FROM users').first()).toBeNull()
		expect(() => unscoped.prepare('SET ROLE postgres')).toThrow(
			'session and schema control',
		)
		// The RLS subject is host-set per transaction; prepared SQL cannot rebind it.
		for (const sql of [
			"SELECT set_config('app.user_id', 'bob', true)",
			"SELECT pg_catalog.SET_CONFIG ('app.user_id', 'bob', true)",
		]) {
			expect(() => db.prepare(sql)).toThrow('session and schema control')
		}
		await expect(
			db.batch([forUser('bob').db.prepare('SELECT * FROM users')]),
		).rejects.toThrow('another database')
		const policyRows = await pg.query<{
			table_name: string
			relrowsecurity: boolean
			relforcerowsecurity: boolean
		}>(
			`SELECT c.table_name, p.relrowsecurity, p.relforcerowsecurity FROM information_schema.columns c JOIN pg_class p ON p.oid = ('public.' || c.table_name)::regclass WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND p.relkind = 'r'`,
		)
		expect(policyRows.rows.length).toBeGreaterThan(50)
		expect(
			policyRows.rows.every(
				(row) => row.relrowsecurity && row.relforcerowsecurity,
			),
		).toBe(true)
	} finally {
		await pg.close()
	}
})

test('parameter scanning preserves quotes, comments and dollar strings; RETURNING and transactions expose real outcomes', async () => {
	const { pg, db } = await createTestDb({ userId: 'alice' })
	try {
		expect(
			await db
				.prepare(
					`SELECT '?' AS literal, ?::text AS bound, $$?$$ AS dollar -- ?\n /* ? */`,
				)
				.bind('actual')
				.first(),
		).toEqual({ literal: '?', bound: 'actual', dollar: '?' })
		// SQLite numbered binds reuse the same value, as `$N` does.
		expect(
			await db
				.prepare(
					'SELECT ?1::text AS first, ?2::text AS second, ?1::text AS again',
				)
				.bind('one', 'two')
				.first(),
		).toEqual({ first: 'one', second: 'two', again: 'one' })
		expect(
			await db
				.prepare('SELECT ?::bigint AS value')
				.bind(1712345678901)
				.first('value'),
		).toBe(1712345678901)
		await expect(
			db.prepare('SELECT 9223372036854775807::bigint AS value').first(),
		).rejects.toThrow('safe integer range')
		const result = await db
			.prepare(
				"INSERT INTO users (username, email, stable_user_id, password_hash) VALUES ('alice', 'alice@example.test', 'alice', 'x') RETURNING id",
			)
			.all<{ id: number }>()
		expect(result.results[0]?.id).toBeGreaterThan(0)
		await expect(
			db.transaction(async (tx) => {
				await tx
					.prepare(
						"INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('rollback', 'alice', 'x', 'x')",
					)
					.run()
				throw new Error('abort')
			}),
		).rejects.toThrow('abort')
		expect(await db.prepare('SELECT id FROM mcp_memories').first()).toBeNull()
		expect(
			await db
				.prepare("SELECT current_setting('app.user_id', true) AS owner")
				.first('owner'),
		).toBe('alice')
	} finally {
		await pg.close()
	}
})

test('pool transactions use one client, set owner context and release on success and failure', async () => {
	const { createPgPoolDatabase, createPgPools, createPgAuditPools } =
		await import('./pg-database.ts')
	const calls: string[] = []
	const client = {
		async query(sql: string, values?: unknown[]) {
			calls.push(sql)
			if (sql.startsWith('SELECT set_config')) expect(values).toEqual(['alice'])
			return {
				rows:
					sql === 'SELECT $1::bigint AS value'
						? [{ value: '1712345678901' }]
						: [],
				rowCount: 0,
				fields: [{ name: 'value', dataTypeID: 20 }],
			}
		},
		release() {
			calls.push('release')
		},
	}
	const pool = {
		async connect() {
			calls.push('connect')
			return client
		},
	} as unknown as Pool
	const db = createPgPoolDatabase({
		pool,
		role: 'kody_writer',
		userId: 'alice',
	})
	expect(
		await db
			.prepare('SELECT ?::bigint AS value')
			.bind(1712345678901)
			.first('value'),
	).toBe(1712345678901)
	expect(calls).toEqual([
		'connect',
		'BEGIN',
		'SET LOCAL ROLE kody_writer',
		"SELECT set_config('app.user_id', $1, true)",
		'SELECT $1::bigint AS value',
		'COMMIT',
		'release',
	])
	calls.length = 0
	await expect(
		db.transaction(async () => {
			throw new Error('query failed')
		}),
	).rejects.toThrow('query failed')
	expect(calls.slice(-2)).toEqual(['ROLLBACK', 'release'])
	const pools = createPgPools({
		writerUrl: 'postgres://kody_writer:mock@localhost/kody',
		readerUrl: 'postgres://kody_reader:mock@localhost/kody',
	})
	const audit = createPgAuditPools({
		writerUrl: 'postgres://kody_audit_writer:mock@localhost/kody_audit',
		readerUrl: 'postgres://kody_audit_reader:mock@localhost/kody_audit',
	})
	try {
		expect(() => pools.forUser('')).toThrow('userId is required')
	} finally {
		await Promise.all([pools.close(), audit.close()])
	}
})

test('nested secret rows follow bucket RLS and the admin role cannot read private content', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	const { db, pg, forUser } = database
	await pg.exec(`INSERT INTO users (id, username, email, stable_user_id, password_hash) VALUES (1, 'alice', 'alice@example.test', 'alice', 'x'), (2, 'bob', 'bob@example.test', 'bob', 'x');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('alice-bucket', 'alice', 'user', 'default'), ('bob-bucket', 'bob', 'user', 'default');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('alice-bucket', 'token', 'alice-cipher'), ('bob-bucket', 'token', 'bob-cipher')`)
	expect(
		await db.prepare('SELECT encrypted_value FROM secret_entries').raw(),
	).toEqual([['alice-cipher']])
	await expect(
		db
			.prepare(
				"INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bob-bucket', 'stolen', 'x')",
			)
			.run(),
	).rejects.toThrow('row-level security')
	expect(
		await forUser('bob')
			.reader.prepare('SELECT encrypted_value FROM secret_entries')
			.raw(),
	).toEqual([['bob-cipher']])
	const admin = createPgDatabase({ connection: pg, role: 'kody_admin' })
	expect(
		(await admin.prepare('SELECT username FROM users ORDER BY id').all())
			.results,
	).toEqual([{ username: 'alice' }, { username: 'bob' }])
	await expect(
		admin.prepare('SELECT encrypted_value FROM secret_entries').all(),
	).rejects.toThrow('permission denied')
	await expect(admin.prepare('SELECT * FROM passkeys').all()).rejects.toThrow(
		'permission denied',
	)
})

test('Postgres delete triggers remove forks by package or source while preserving another owner', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	await database.pg
		.exec(`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id) VALUES ('package', 'alice', 'package', '@alice/package', '', 'source');
		INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, created_at, updated_at) VALUES ('source', 'alice', 'package', 'package', 'repo', '2026-09-30', '2026-09-30');
		INSERT INTO community_forks (id, listing_id, forker_user_id, origin_commit, forked_package_id, forked_source_id, target_kody_id) VALUES
		('by-package', 'listing', 'alice', 'commit', 'package', 'other-source', '@alice/a'),
		('by-source', 'listing', 'alice', 'commit', 'inert-package', 'source', '@alice/b'),
		('bob', 'listing', 'bob', 'commit', 'package', 'source', '@bob/b');`)
	expect(
		(
			await database.db
				.prepare('SELECT id FROM community_forks ORDER BY id')
				.all()
		).results,
	).toEqual([{ id: 'by-package' }, { id: 'by-source' }])
	await database.db
		.prepare("DELETE FROM saved_packages WHERE id = 'package'")
		.run()
	expect(
		await database.db.prepare('SELECT id FROM community_forks').first(),
	).toBeNull()
	await database.db
		.prepare(
			"INSERT INTO community_forks (id, listing_id, forker_user_id, origin_commit, forked_package_id, forked_source_id, target_kody_id) VALUES ('inert', 'listing', 'alice', 'commit', 'inert-package', 'source', '@alice/c')",
		)
		.run()
	await database.db
		.prepare("DELETE FROM entity_sources WHERE id = 'source'")
		.run()
	expect(
		await database.db.prepare('SELECT id FROM community_forks').first(),
	).toBeNull()
	expect(
		await database
			.forUser('bob')
			.db.prepare('SELECT id FROM community_forks')
			.first('id'),
	).toBe('bob')
})
