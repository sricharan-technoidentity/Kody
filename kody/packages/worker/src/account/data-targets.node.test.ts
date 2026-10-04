import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	accountExportForeignUserIdColumnsByTable,
	accountExportRedactedColumnsByTable,
	accountExportRedactedForeignUserId,
	accountOperatorOwnedD1Surfaces,
	accountSubjectAnonymizeSql,
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	getAccountD1UserColumnCoverage,
	getAccountExportExcludedD1Surfaces,
	isExcludedFromAccountExport,
	type UserScopedDataTarget,
} from './data-targets.ts'

/**
 * User columns deliberately outside the D1 inventory: their owners purge and
 * export them (JOBS purgeUser / listJobsForUser, the search-index adapter);
 * MCP_CLIENTS purges its Aurora catalog and Identity credentials, with SDK state
 * explicitly excluded from portable exports, and
 * `isolation_probe` is the P2 RLS fixture.
 */
const userColumnsOwnedElsewhere = new Set([
	'mcp_client_hubs.user_id',
	'mcp_client_values.user_id',
	'jobs.user_id',
	'archived_job_artifacts.user_id',
	'search_vectors.user_id',
	'isolation_probe.user_id',
])

async function schemaUserColumns() {
	await using database = await createTestDb()
	const { rows } = await database.pg.query<{
		table_name: string
		column_name: string
	}>(
		`SELECT c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables t
			ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
	)
	const tables = new Map<string, Array<string>>()
	for (const row of rows) {
		tables.set(row.table_name, [
			...(tables.get(row.table_name) ?? []),
			row.column_name,
		])
	}
	const userColumns = new Set(
		rows
			.filter(
				(row) =>
					row.column_name === 'user_id' || row.column_name.endsWith('_user_id'),
			)
			.map((row) => `${row.table_name}.${row.column_name}`)
			.filter((column) => !userColumnsOwnedElsewhere.has(column)),
	)
	return { tables, userColumns }
}

function expectInventoryCoversSchema(userColumns: Set<string>) {
	const coveredColumns = getAccountD1UserColumnCoverage()
	expect(
		[...userColumns].filter((column) => !coveredColumns.has(column)),
	).toEqual([])
	expect(
		[...coveredColumns].filter((column) => !userColumns.has(column)),
	).toEqual([])
}

function matchFor(target: UserScopedDataTarget) {
	return buildUserScopedTargetMatch({
		target,
		mcpUserId: 'user-aaa',
		dbUserId: 42,
	})
}

test('shared user-scoped target match SQL is identical for deletion and export shapes', () => {
	const samples: Array<UserScopedDataTarget> = [
		{ kind: 'user_id', table: 'jobs' },
		{ kind: 'db_user_id', table: 'passkeys' },
		{ kind: 'db_user_target', table: 'verifications' },
		{
			kind: 'user_columns',
			table: 'community_activity_events',
			columns: ['actor_user_id'],
		},
		{
			kind: 'null_user_column',
			table: 'platform_feedback',
			matchColumn: 'reviewed_by_user_id',
			nullColumns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
			includeInExport: false,
		},
		{
			kind: 'replace_user_column',
			table: 'community_bans',
			matchColumn: 'banned_by_user_id',
			setColumn: 'banned_by_user_id',
			value: 'deleted-user',
		},
		{
			kind: 'replace_user_id_in_json_column',
			table: 'package_codemod_runs',
			column: 'filters_json',
			value: 'deleted-user',
			includeInExport: false,
			surface: 'package_codemod_runs_filters_json',
			reason: 'test',
		},
		{
			kind: 'bucket_parent',
			table: 'value_entries',
			parentTable: 'value_buckets',
		},
		{
			kind: 'community_listing_child',
			table: 'community_ratings',
			listingColumn: 'listing_id',
		},
		{ kind: 'mcp_memory_suppression' },
	]

	expect(matchFor(samples[0]!)).toEqual({
		table: 'jobs',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'jobs.user_id = ?',
		params: ['user-aaa'],
		mutation: { kind: 'delete' },
	})
	expect(buildUserScopedDeleteOrUpdateSql(matchFor(samples[0]!))).toEqual({
		sql: 'DELETE FROM jobs WHERE user_id = ?',
		params: ['user-aaa'],
	})

	expect(matchFor(samples[1]!)).toEqual({
		table: 'passkeys',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'passkeys.user_id = ?',
		params: [42],
		mutation: { kind: 'delete' },
	})
	expect(matchFor(samples[2]!)).toEqual({
		table: 'verifications',
		whereSql: 'target = ?',
		qualifiedWhereSql: 'verifications.target = ?',
		params: ['42'],
		mutation: { kind: 'delete' },
	})
	expect(matchFor(samples[3]!)).toEqual({
		table: 'community_activity_events',
		whereSql: 'actor_user_id = ?',
		qualifiedWhereSql: 'community_activity_events.actor_user_id = ?',
		params: ['user-aaa'],
		mutation: { kind: 'delete' },
	})

	const nullMatch = matchFor(samples[4]!)
	expect(nullMatch.mutation).toEqual({
		kind: 'null_columns',
		columns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
	})
	expect(buildUserScopedDeleteOrUpdateSql(nullMatch)).toEqual({
		sql: `UPDATE platform_feedback
						SET reviewed_by_user_id = NULL, reviewed_at = NULL, admin_note = NULL
						WHERE reviewed_by_user_id = ?`,
		params: ['user-aaa'],
	})

	const replaceMatch = matchFor(samples[5]!)
	expect(buildUserScopedDeleteOrUpdateSql(replaceMatch)).toEqual({
		sql: `UPDATE community_bans
						SET banned_by_user_id = ?
						WHERE banned_by_user_id = ?`,
		params: ['deleted-user', 'user-aaa'],
	})

	const replaceJsonMatch = matchFor(samples[6]!)
	expect(replaceJsonMatch).toEqual({
		table: 'package_codemod_runs',
		whereSql: "length(replace(filters_json, ?, '')) < length(filters_json)",
		qualifiedWhereSql:
			"length(replace(package_codemod_runs.filters_json, ?, '')) < length(package_codemod_runs.filters_json)",
		params: ['"user-aaa"'],
		mutation: {
			kind: 'replace_json_string',
			column: 'filters_json',
			search: '"user-aaa"',
			replacement: '"deleted-user"',
		},
	})
	expect(buildUserScopedDeleteOrUpdateSql(replaceJsonMatch)).toEqual({
		sql: `UPDATE package_codemod_runs
						SET filters_json = REPLACE(filters_json, ?, ?)
						WHERE length(replace(filters_json, ?, '')) < length(filters_json)`,
		params: ['"user-aaa"', '"deleted-user"', '"user-aaa"'],
	})

	expect(matchFor(samples[7]!).qualifiedWhereSql).toBe(
		`value_entries.bucket_id IN (
						SELECT id FROM value_buckets WHERE user_id = ?
					)`,
	)
	expect(matchFor(samples[8]!).qualifiedWhereSql).toBe(
		`community_ratings.listing_id IN (
						SELECT id FROM community_listings WHERE owner_user_id = ?
					)`,
	)
	expect(matchFor(samples[9]!)).toEqual({
		table: 'mcp_memory_conversation_suppressions',
		whereSql: 'user_id = ?',
		qualifiedWhereSql: 'mcp_memory_conversation_suppressions.user_id = ?',
		params: ['user-aaa'],
		mutation: { kind: 'delete' },
	})
})

test('every accountUserDataTargets kind has a shared match builder and export guards', () => {
	for (const target of accountUserDataTargets) {
		const match = matchFor(target)
		expect(match.table.length).toBeGreaterThan(0)
		expect(match.whereSql.length).toBeGreaterThan(0)
		expect(match.qualifiedWhereSql).toContain(match.table)
		expect(match.params.length).toBeGreaterThan(0)
		const statement = buildUserScopedDeleteOrUpdateSql(match)
		expect(statement.sql).toContain(match.table)
		expect(statement.params.length).toBeGreaterThan(0)
	}

	expect(accountExportRedactedColumnsByTable.users).toContain('password_hash')
	expect(accountExportRedactedColumnsByTable.secret_entries).toEqual(
		expect.arrayContaining(['encrypted_value', 'lookup_hash']),
	)
	expect(accountExportRedactedColumnsByTable.user_integrations).toEqual(
		expect.arrayContaining([
			'access_token_encrypted',
			'refresh_token_encrypted',
		]),
	)
	expect(accountExportRedactedColumnsByTable.user_oauth_apps).toEqual(
		expect.arrayContaining(['client_secret_encrypted']),
	)
	expect(accountExportRedactedColumnsByTable.webhook_endpoints).toEqual(
		expect.arrayContaining([
			'url_secret_hash',
			'url_secret_encrypted',
			'previous_url_secret_hash',
		]),
	)
	expect(
		accountExportRedactedColumnsByTable.webhook_apply_destination_pending,
	).toEqual(['destination_json'])
	expect(
		accountExportRedactedColumnsByTable.webhook_apply_destination_grants,
	).toEqual(['destination_json'])
	expect(
		accountExportForeignUserIdColumnsByTable.community_activity_events,
	).toEqual(expect.arrayContaining(['actor_user_id']))
	expect(accountExportRedactedForeignUserId.length).toBeGreaterThan(0)

	const excludedListingChildren = accountUserDataTargets.filter(
		(target) =>
			target.kind === 'community_listing_child' &&
			target.includeInExport === false,
	)
	expect(excludedListingChildren.length).toBeGreaterThan(0)
	expect(
		excludedListingChildren.every((target) =>
			target.table.startsWith('community_'),
		),
	).toBe(true)
})

test('operator-owned tables are explicit deletion/export exclusions', async () => {
	const { tables } = await schemaUserColumns()
	const expectedTables = [
		'platform_oauth_apps',
		'platform_provider_marks',
		'repo_session_storage_bucket_cursor',
		'site_banners',
		'system_email_attachments',
		'system_email_delivery_events',
		'system_email_messages',
		'system_email_threads',
	]
	expect(
		accountOperatorOwnedD1Surfaces.map((surface) => surface.table).sort(),
	).toEqual(expectedTables)
	for (const table of expectedTables) {
		expect(tables.get(table)).toBeDefined()
		expect(tables.get(table)).not.toContain('user_id')
		expect(
			accountUserDataTargets.some(
				(target) => 'table' in target && target.table === table,
			),
		).toBe(false)
	}
	expect(getAccountExportExcludedD1Surfaces()).toEqual(
		expect.arrayContaining(
			expectedTables.map((table) =>
				expect.objectContaining({
					name: table,
					reason: expect.stringContaining(
						table === 'platform_oauth_apps'
							? 'Operator-provisioned built-in OAuth app'
							: table === 'platform_provider_marks'
								? 'Operator-owned provider brand marks'
								: table === 'site_banners'
									? 'Operator-owned site announcement'
									: table.startsWith('repo_session_')
										? 'Platform-owned'
										: 'operator-owned system email',
					),
				}),
			),
		),
	)
})

test('account deletion statements never bind a LIKE or GLOB pattern', () => {
	// Stable ids must match literally: a LIKE pattern would need wildcard
	// escaping (and D1 once rejected 68-byte patterns in the purge lane).
	const stableUserId = 'f'.repeat(64)
	for (const target of accountUserDataTargets) {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: stableUserId,
			dbUserId: 1,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		expect(sql).not.toMatch(/\b(LIKE|GLOB)\b/iu)
		for (const param of params) {
			if (typeof param !== 'string') continue
			expect(param.startsWith('%') || param.endsWith('%')).toBe(false)
		}
	}
})

test('final schema drops entitlement_daily_counters without stale inventory coverage', async () => {
	const deletionStatements = accountUserDataTargets.map((target) => {
		const match = matchFor(target)
		return buildUserScopedDeleteOrUpdateSql(match).sql
	})
	expect(deletionStatements.join('\n')).not.toMatch(
		/entitlement_daily_counters/u,
	)

	const exportStatements = accountUserDataTargets
		.filter((target) => !isExcludedFromAccountExport(target))
		.map((target) => {
			const match = matchFor(target)
			return `SELECT * FROM ${match.table} WHERE ${match.qualifiedWhereSql}`
		})
	expect(exportStatements.join('\n')).not.toMatch(/entitlement_daily_counters/u)

	const { tables, userColumns } = await schemaUserColumns()
	expect(tables.has('entitlement_daily_counters')).toBe(false)
	expect(userColumns.has('entitlement_daily_counters.user_id')).toBe(false)
	expectInventoryCoversSchema(userColumns)
})

test('final schema drops legacy RunLog D1 projections without stale inventory coverage', async () => {
	const retiredTables = [
		'workflow_runs',
		'user_package_run_successes',
		'user_activation_milestones',
	] as const

	const deletionStatements = accountUserDataTargets.map((target) => {
		const match = matchFor(target)
		return buildUserScopedDeleteOrUpdateSql(match).sql
	})
	const exportStatements = accountUserDataTargets
		.filter((target) => !isExcludedFromAccountExport(target))
		.map((target) => {
			const match = matchFor(target)
			return `SELECT * FROM ${match.table} WHERE ${match.qualifiedWhereSql}`
		})
	const inventorySql = [
		deletionStatements.join('\n'),
		exportStatements.join('\n'),
	].join('\n')
	for (const table of retiredTables) {
		expect(inventorySql).not.toMatch(new RegExp(`\\b${table}\\b`, 'u'))
	}

	const { tables, userColumns } = await schemaUserColumns()
	for (const table of retiredTables) {
		expect(tables.has(table), `${table} should be absent`).toBe(false)
		expect(userColumns.has(`${table}.user_id`)).toBe(false)
	}
	expectInventoryCoversSchema(userColumns)
})

const subject = { id: 10, stableUserId: 'subject-s' }

async function createSubjectTestDb() {
	const database = await createTestDb()
	await database.pg.exec(`
		INSERT INTO users (id, stable_user_id, username, email, password_hash) VALUES
			(10, 'subject-s', 'subject', 's@example.com', 'x'),
			(11, 'other-o', 'other', 'o@example.com', 'x'),
			(12, 'third-t', 'third', 't@example.com', 'x');
		INSERT INTO credit_ledger_entries (id, user_id, kind, amount_micro_usd, granted_by_user_id, created_at) VALUES
			('cl-own', 'subject-s', 'top_up', 5, NULL, 'now'),
			('cl-granted', 'other-o', 'admin_grant', 5, 'subject-s', 'now'),
			('cl-bystander', 'third-t', 'admin_grant', 5, 'other-o', 'now');
		INSERT INTO platform_feedback (id, submitter_user_id, category, summary, details, reviewed_by_user_id, reviewed_at, admin_note, created_at, updated_at, submitter_username, submitter_email) VALUES
			('fb-other', 'other-o', 'bug', 's', 'd', 'subject-s', 'now', 'note', 'now', 'now', 'other', 'o@example.com');
		INSERT INTO community_listings (id, owner_user_id, package_id, source_id, kody_id, name, description, license, pinned_commit) VALUES
			('lst-subject', 'subject-s', 'p1', 's1', 'k1', 'n', 'd', 'MIT', 'c'),
			('lst-other', 'other-o', 'p2', 's2', 'k2', 'n', 'd', 'MIT', 'c');
		INSERT INTO community_ratings (id, listing_id, user_id, stars, adaptation_effort) VALUES
			('rt-other-on-subject', 'lst-subject', 'other-o', 5, 1),
			('rt-subject-on-other', 'lst-other', 'subject-s', 4, 1),
			('rt-third-on-other', 'lst-other', 'third-t', 3, 1);
		INSERT INTO package_codemod_runs (id, codemod_id, mode, scope_user_id, initiated_by_user_id, filters_json, status, created_at, updated_at) VALUES
			('run-fleet', 'cm', 'apply', 'other-o', 'other-o', '{"userIds":["subject-s","third-t"]}', 'done', 'now', 'now');
		INSERT INTO value_buckets (id, user_id, scope, binding_key) VALUES
			('vb-subject', 'subject-s', 'user', 'k'), ('vb-other', 'other-o', 'user', 'k');
		INSERT INTO value_entries (bucket_id, name, value) VALUES
			('vb-subject', 'a', '1'), ('vb-other', 'a', '1');
		INSERT INTO passkeys (id, aaguid, public_key, user_id, webauthn_user_handle, device_type) VALUES
			('pk-subject', 'a', 'k', 10, 'h', 'single'), ('pk-other', 'a', 'k', 11, 'h', 'single');
		INSERT INTO verifications (type, target, secret, algorithm, digits, period, char_set) VALUES
			('2fa', '10', 's', 'SHA1', 6, 30, 'A'), ('2fa', '11', 's', 'SHA1', 6, 30, 'A');
		INSERT INTO package_scope_grants (scope_owner_user_id, grantee_user_id, created_by_user_id) VALUES
			('subject-s', 'other-o', 'third-t'), ('other-o', 'third-t', 'subject-s');
	`)
	const as = (
		role: 'kody_subject_reader' | 'kody_subject_purger' | 'kody_writer',
	) =>
		createPgDatabase({
			connection: database.pg,
			role,
			userId: subject.stableUserId,
		})
	return {
		...database,
		as,
		async rows(sql: string) {
			return (await database.pg.query(sql)).rows
		},
	}
}

/** Mirrors deleteUserScopedRowsAndUser's PostgreSQL batch. */
function deletionStatements(db: ReturnType<typeof createPgDatabase>) {
	return [
		db.prepare(accountSubjectAnonymizeSql),
		...accountUserDataTargets.flatMap((target) => {
			const match = buildUserScopedTargetMatch({
				target,
				mcpUserId: subject.stableUserId,
				dbUserId: subject.id,
			})
			if (match.mutation.kind !== 'delete') return []
			const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
			return [db.prepare(sql).bind(...params)]
		}),
		db.prepare(`DELETE FROM users WHERE id = ?`).bind(subject.id),
	]
}

test('kody_subject_purger runs the deletion inventory atomically and leaves no subject id behind', async () => {
	await using database = await createSubjectTestDb()

	// Ordinary owner roles cannot anonymize (RLS hides other users' rows, so the
	// definer is purger-only); the failed batch rolls back as a unit.
	const writer = database.as('kody_writer')
	await expect(writer.batch(deletionStatements(writer))).rejects.toThrow(
		'permission denied for function kody_subject_anonymize',
	)
	await expect(
		createPgDatabase({ connection: database.pg, role: 'kody_subject_purger' })
			.prepare(accountSubjectAnonymizeSql)
			.all(),
	).rejects.toThrow('app.user_id is required')
	expect(
		await database.rows(`SELECT COUNT(*)::int AS count FROM value_entries`),
	).toEqual([{ count: 2 }])

	const purger = database.as('kody_subject_purger')
	const [anonymized] = await purger.batch<{
		target_ordinal: number
		changed_rows: number
	}>(deletionStatements(purger))
	expect(
		anonymized!.results
			.filter((row) => row.changed_rows > 0)
			.map((row) => accountUserDataTargets[row.target_ordinal]),
	).toEqual([
		expect.objectContaining({ table: 'credit_ledger_entries' }),
		expect.objectContaining({
			table: 'package_codemod_runs',
			column: 'filters_json',
		}),
		expect.objectContaining({ table: 'platform_feedback' }),
		expect.objectContaining({ table: 'package_scope_grants' }),
	])

	expect(
		await database.rows(`SELECT stable_user_id FROM users ORDER BY id`),
	).toEqual([{ stable_user_id: 'other-o' }, { stable_user_id: 'third-t' }])
	expect(
		await database.rows(
			`SELECT id, user_id, granted_by_user_id FROM credit_ledger_entries ORDER BY id`,
		),
	).toEqual([
		{ id: 'cl-bystander', user_id: 'third-t', granted_by_user_id: 'other-o' },
		{
			id: 'cl-granted',
			user_id: 'other-o',
			granted_by_user_id: 'deleted-user',
		},
	])
	expect(
		await database.rows(
			`SELECT id, reviewed_by_user_id, reviewed_at, admin_note FROM platform_feedback`,
		),
	).toEqual([
		{
			id: 'fb-other',
			reviewed_by_user_id: null,
			reviewed_at: null,
			admin_note: null,
		},
	])
	expect(await database.rows(`SELECT id FROM community_listings`)).toEqual([
		{ id: 'lst-other' },
	])
	expect(await database.rows(`SELECT id FROM community_ratings`)).toEqual([
		{ id: 'rt-third-on-other' },
	])
	expect(
		await database.rows(`SELECT filters_json FROM package_codemod_runs`),
	).toEqual([{ filters_json: '{"userIds":["deleted-user","third-t"]}' }])
	expect(await database.rows(`SELECT bucket_id FROM value_entries`)).toEqual([
		{ bucket_id: 'vb-other' },
	])
	expect(await database.rows(`SELECT id FROM passkeys`)).toEqual([
		{ id: 'pk-other' },
	])
	expect(await database.rows(`SELECT target FROM verifications`)).toEqual([
		{ target: '11' },
	])
	expect(
		await database.rows(
			`SELECT scope_owner_user_id, grantee_user_id, created_by_user_id FROM package_scope_grants`,
		),
	).toEqual([
		{
			scope_owner_user_id: 'other-o',
			grantee_user_id: 'third-t',
			created_by_user_id: 'deleted-user',
		},
	])

	// Every inventory column is free of the subject's stable and integer ids.
	const { rows: columnTypes } = await database.pg.query<{
		table_name: string
		column_name: string
		data_type: string
	}>(
		`SELECT table_name, column_name, data_type FROM information_schema.columns
		WHERE table_schema = 'public'`,
	)
	for (const column of getAccountD1UserColumnCoverage()) {
		const [table, name] = column.split('.') as [string, string]
		const type = columnTypes.find(
			(row) => row.table_name === table && row.column_name === name,
		)?.data_type
		const value = type === 'bigint' ? subject.id : subject.stableUserId
		const { rows } = await database.pg.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${name} = $1`,
			[value],
		)
		expect({ column, count: rows[0]!.count }).toEqual({ column, count: 0 })
	}
})

test('kody_subject_reader sees exactly the export inventory rows and cannot write', async () => {
	await using database = await createSubjectTestDb()
	const reader = database.as('kody_subject_reader')
	const ids = async (table: string) =>
		(
			await reader
				.prepare(`SELECT id FROM ${table} ORDER BY id`)
				.all<{ id: string }>()
		).results.map((row) => row.id)

	// Grants the subject made are part of their export; others' ledgers are not.
	expect(await ids('credit_ledger_entries')).toEqual(['cl-granted', 'cl-own'])
	// Listing-owner export excludes other users' ratings on the listing.
	expect(await ids('community_ratings')).toEqual(['rt-subject-on-other'])
	expect(await ids('community_listings')).toEqual(['lst-subject'])
	// Reviewer metadata is deletion-only: the reviewed feedback is not exported.
	expect(await ids('platform_feedback')).toEqual([])
	expect(await ids('passkeys')).toEqual(['pk-subject'])
	expect(
		await reader.prepare(`SELECT stable_user_id FROM users`).all(),
	).toEqual(
		expect.objectContaining({ results: [{ stable_user_id: 'subject-s' }] }),
	)
	await expect(
		reader.prepare(`DELETE FROM passkeys WHERE id = 'pk-subject'`).run(),
	).rejects.toThrow('read-only transaction')
	expect(
		await database.rows(`SELECT COUNT(*)::int AS count FROM passkeys`),
	).toEqual([{ count: 2 }])
})
