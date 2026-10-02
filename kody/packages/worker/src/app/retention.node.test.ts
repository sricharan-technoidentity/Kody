import { expect, test, vi } from 'vitest'
import {
	agentPackageConversationUseRetentionDays,
	auditEventRetentionDays,
	featureFlagExposureRetentionDays,
	getRetentionPolicyCoverage,
	memorySuppressionRetentionDays,
	platformFeedbackRetentionDays,
	pruneAgentPackageConversationUsesForRetention,
	pruneAuditEventsForRetention,
	pruneFeatureFlagExposuresForRetention,
	pruneMemorySuppressionsForRetention,
	prunePlatformFeedbackForRetention,
	prunePublishedBundleArtifactsForRetention,
	pruneRetention,
	pruneStripeWebhookEventsForRetention,
	pruneUsageRollupsForRetention,
	publishedBundleArtifactRetentionDays,
	shouldRunRetentionCron,
	stripeWebhookEventRetentionDays,
} from './retention.ts'
import { createPgDatabase, type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestAuditDb } from '#worker/test-support/aws/test-audit-db.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'

type Rows = Array<Record<string, unknown>>
type Sql = (query: string, ...params: Array<unknown>) => Promise<Rows>

/** Superuser fixture queries (`?` binds) that bypass RLS: seeding and assertions only. */
function fixtureSql(pg: {
	query: (sql: string, params: Array<unknown>) => Promise<{ rows: Rows }>
}): Sql {
	return async (query, ...params) => {
		let index = 0
		return (
			await pg.query(
				query.replace(/\?/g, () => `$${++index}`),
				params,
			)
		).rows
	}
}

/** Fails a statement that binds more values than the limit, like D1. */
function withMaxBindings(db: PgDatabase, maxBindings: number): PgDatabase {
	return {
		...db,
		prepare(query: string) {
			const statement = db.prepare(query)
			return {
				...statement,
				bind(...params: Array<unknown>) {
					if (params.length > maxBindings) {
						throw new Error(`too many SQL variables: ${params.length}`)
					}
					return statement.bind(...params)
				},
			} as typeof statement
		},
	}
}

/**
 * The application and audit databases, each seen through the retention
 * lane's role: fleet-wide read and delete on the pruned tables only.
 */
async function createRetentionDb() {
	const store = await createTestDb()
	const audit = await createTestAuditDb()
	const retentionDb = createPgDatabase({
		connection: store.pg,
		role: 'kody_retention',
	})
	return {
		retentionDb,
		db: retentionDb as unknown as D1Database,
		auditDb: createPgDatabase({
			connection: audit.pg,
			role: 'kody_audit_retention',
		}) as unknown as D1Database,
		sql: fixtureSql(store.pg),
		auditSql: fixtureSql(audit.pg),
		store,
		async [Symbol.asyncDispose]() {
			await store[Symbol.asyncDispose]()
			await audit[Symbol.asyncDispose]()
		},
	}
}

const now = new Date('2026-07-07T00:00:00.000Z')

function daysAgo(days: number) {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

async function insertPlatformFeedback(
	sql: Sql,
	input: { id: string; updatedAt: string; status?: string },
) {
	await sql(
		`INSERT INTO platform_feedback (
			id, submitter_user_id, category, summary, details, status,
			created_at, updated_at, submitter_username, submitter_email
		) VALUES (?, 'user-1', 'bug', 'summary', 'details', ?, ?, ?, 'user-1', 'user-1@example.com')`,
		input.id,
		input.status ?? 'resolved',
		input.updatedAt,
		input.updatedAt,
	)
}

async function insertAuditEvent(sql: Sql, input: { timestamp: string }) {
	await sql(
		`INSERT INTO audit_events (
			category, action, result, timestamp
		) VALUES ('auth', 'login', 'success', ?)`,
		input.timestamp,
	)
}

async function idsForAuditEvents(sql: Sql) {
	return (
		await sql(`SELECT timestamp FROM audit_events ORDER BY timestamp ASC`)
	).map((row) => row.timestamp)
}

async function idsForTable(sql: Sql, table: string) {
	return (await sql(`SELECT id FROM ${table} ORDER BY id ASC`)).map(
		(row) => row.id,
	)
}

test('retention cron runs only on the hourly gate', () => {
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:00:00.000Z'))).toBe(
		true,
	)
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:05:00.000Z'))).toBe(
		false,
	)
})

test('platform feedback retention prunes terminal rows in bounded batches and runs round-robin', async () => {
	await using retention = await createRetentionDb()
	const { sql, db, auditDb } = retention
	for (const [id, status, updatedAt] of [
		[
			'terminal-old-resolved',
			'resolved',
			daysAgo(platformFeedbackRetentionDays + 2),
		],
		[
			'terminal-old-dismissed',
			'dismissed',
			daysAgo(platformFeedbackRetentionDays + 1),
		],
		['terminal-boundary', 'resolved', daysAgo(platformFeedbackRetentionDays)],
		['active-old-open', 'open', daysAgo(platformFeedbackRetentionDays + 10)],
		[
			'active-old-triaged',
			'triaged',
			daysAgo(platformFeedbackRetentionDays + 10),
		],
	] as const) {
		await insertPlatformFeedback(sql, { id, status, updatedAt })
	}

	expect(
		await prunePlatformFeedbackForRetention({ db, now, batchSize: 1 }),
	).toEqual({ selected: 1, deleted: 1 })
	expect(
		await prunePlatformFeedbackForRetention({ db, now, batchSize: 1 }),
	).toEqual({ selected: 1, deleted: 1 })
	expect(
		await prunePlatformFeedbackForRetention({ db, now, batchSize: 1 }),
	).toEqual({ selected: 0, deleted: 0 })
	expect(await idsForTable(sql, 'platform_feedback')).toEqual([
		'active-old-open',
		'active-old-triaged',
		'terminal-boundary',
	])

	await insertPlatformFeedback(sql, {
		id: 'runner-delete',
		updatedAt: daysAgo(platformFeedbackRetentionDays + 1),
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<
		Env,
		'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'
	>
	const result = await pruneRetention({ env, now })
	expect(result.platformFeedback).toBe(1)
	expect(result.agentPackageConversationUses).toBe(0)
	expect(result.batchesPerTable['platform_feedback']).toBe(1)
	expect(result.batchesPerTable['agent_package_conversation_uses']).toBe(1)
	expect(await idsForTable(sql, 'platform_feedback')).toEqual([
		'active-old-open',
		'active-old-triaged',
		'terminal-boundary',
	])
})

test('memory suppression, audit, and stripe webhook retention respect boundaries', async () => {
	await using retention = await createRetentionDb()
	const { sql, auditSql, db, auditDb } = retention
	for (const [memoryId, lastSeenAt, expiresAt] of [
		[
			'memory-old-expired',
			daysAgo(memorySuppressionRetentionDays + 1),
			daysAgo(1),
		],
		['memory-boundary', daysAgo(memorySuppressionRetentionDays), daysAgo(1)],
		['memory-active', daysAgo(memorySuppressionRetentionDays + 1), daysAgo(-1)],
	]) {
		await sql(
			`INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES (?, 'user-1', 's', 's')`,
			memoryId,
		)
		await sql(
			`INSERT INTO mcp_memory_conversation_suppressions (
				user_id, conversation_id, memory_id, created_at, last_seen_at, expires_at
			) VALUES ('user-1', 'conversation', ?, ?, ?, ?)`,
			memoryId,
			lastSeenAt,
			lastSeenAt,
			expiresAt,
		)
	}
	for (const [timestamp] of [
		[daysAgo(auditEventRetentionDays + 1)],
		[daysAgo(auditEventRetentionDays)],
	]) {
		await insertAuditEvent(auditSql, { timestamp })
	}
	for (const [eventId, processedAt] of [
		['evt_old', daysAgo(stripeWebhookEventRetentionDays + 1)],
		['evt_boundary', daysAgo(stripeWebhookEventRetentionDays)],
	]) {
		await sql(
			`INSERT INTO stripe_webhook_events (
				event_id, event_type, processed_at
			) VALUES (?, 'checkout.session.completed', ?)`,
			eventId,
			processedAt,
		)
	}
	for (const [packageId, lastUsedAt] of [
		['pkg-old', daysAgo(agentPackageConversationUseRetentionDays + 1)],
		['pkg-boundary', daysAgo(agentPackageConversationUseRetentionDays)],
		['pkg-recent', daysAgo(1)],
	]) {
		await sql(
			`INSERT INTO agent_package_conversation_uses (
				user_id, package_id, conversation_id, first_used_at, last_used_at
			) VALUES ('user-1', ?, 'conversation', ?, ?)`,
			packageId,
			lastUsedAt,
			lastUsedAt,
		)
	}

	expect(await pruneMemorySuppressionsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(await pruneAuditEventsForRetention({ db: auditDb, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(await pruneStripeWebhookEventsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(
		await pruneAgentPackageConversationUsesForRetention({ db, now }),
	).toEqual({
		selected: 1,
		deleted: 1,
	})

	const memories = (await sql(`SELECT memory_id
			FROM mcp_memory_conversation_suppressions
			ORDER BY memory_id`)) as Array<{ memory_id: string }>
	expect(memories.map((row) => row.memory_id)).toEqual([
		'memory-active',
		'memory-boundary',
	])
	expect(await idsForAuditEvents(auditSql)).toEqual([
		daysAgo(auditEventRetentionDays),
	])
	expect(
		(
			(await sql(
				`SELECT event_id FROM stripe_webhook_events ORDER BY event_id`,
			)) as Array<{ event_id: string }>
		).map((row) => row.event_id),
	).toEqual(['evt_boundary'])
	expect(
		(
			(await sql(
				`SELECT package_id FROM agent_package_conversation_uses ORDER BY package_id`,
			)) as Array<{ package_id: string }>
		).map((row) => row.package_id),
	).toEqual(['pkg-boundary', 'pkg-recent'])
})

test('retention prune reports selected separately from deleted when rows vanish mid-batch', async () => {
	await using retention = await createRetentionDb()
	const { sql, retentionDb } = retention
	// Simulate a racing writer deleting one selected row before the batch
	// DELETE runs: selected stays at the full batch size so hasMore-style
	// decisions keep looping instead of marking the table drained.
	const dbWithVanishingRow = {
		...retentionDb,
		prepare(query: string) {
			const prepared = retentionDb.prepare(query)
			if (!query.includes('DELETE FROM platform_feedback')) return prepared
			return {
				...prepared,
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params)
					return {
						...bound,
						async run() {
							await sql(`DELETE FROM platform_feedback WHERE id = 'feedback-0'`)
							return bound.run()
						},
					} as typeof bound
				},
			} as typeof prepared
		},
	} satisfies PgDatabase as unknown as D1Database
	for (let index = 0; index < 2; index += 1) {
		await insertPlatformFeedback(sql, {
			id: `feedback-${index}`,
			updatedAt: daysAgo(platformFeedbackRetentionDays + 1),
		})
	}

	expect(
		await prunePlatformFeedbackForRetention({
			db: dbWithVanishingRow,
			now,
			batchSize: 2,
		}),
	).toEqual({ selected: 2, deleted: 1 })
})

test('usage rollup retention respects month boundaries', async () => {
	await using retention = await createRetentionDb()
	const { sql, db } = retention
	// 24 months before 2026-07 keeps 2024-07 and later.
	for (const month of ['2024-06', '2024-07', '2026-06']) {
		await sql(
			`INSERT INTO usage_rollups (
				user_id, metric, month, event_count, updated_at
			) VALUES ('user-1', 'mcp_tool_call', ?, 1, ?)`,
			month,
			now.toISOString(),
		)
	}

	expect(await pruneUsageRollupsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})

	const months = (await sql(
		`SELECT month FROM usage_rollups ORDER BY month`,
	)) as Array<{ month: string }>
	expect(months.map((row) => row.month)).toEqual(['2024-07', '2026-06'])
})

test('feature flag exposure rollup retention respects the day boundary', async () => {
	await using retention = await createRetentionDb()
	const { sql, db } = retention
	const cutoffDay = daysAgo(featureFlagExposureRetentionDays).slice(0, 10)
	for (const day of [
		daysAgo(featureFlagExposureRetentionDays + 1).slice(0, 10),
		cutoffDay,
		daysAgo(1).slice(0, 10),
	]) {
		await sql(
			`INSERT INTO feature_flag_exposure_rollups (
				flag_key, user_id, day, enabled, source, exposure_count, updated_at
			) VALUES ('retired-flag', 'user-1', ?, 1, 'rollout', 1, ?)`,
			day,
			now.toISOString(),
		)
	}

	expect(await pruneFeatureFlagExposuresForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	const days = (await sql(
		`SELECT day FROM feature_flag_exposure_rollups ORDER BY day`,
	)) as Array<{ day: string }>
	expect(days.map((row) => row.day)).toEqual([
		cutoffDay,
		daysAgo(1).slice(0, 10),
	])
})

test('published bundle artifact retention deletes stale rows, KV blobs, and source snapshots', async () => {
	await using retention = await createRetentionDb()
	const { sql, db } = retention
	const kvDelete = vi.fn(async () => undefined)
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	await indexEnv
		.REPO_SESSION_INDEX!.get(indexEnv.REPO_SESSION_INDEX!.idFromName('user-1'))
		.insertSession({
			ownerId: 'user-1',
			row: {
				id: 'session-1',
				user_id: 'user-1',
				source_id: 'source-session',
				source_repo_id: 'repo-1',
				session_branch: 'sessions/session-1',
				source_branch: 'main',
				base_commit: 'commit',
				source_root: '/',
				conversation_id: null,
				status: 'active',
				expires_at: null,
				last_checkpoint_at: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				created_at: daysAgo(1),
				updated_at: daysAgo(1),
			} satisfies RepoSessionRow,
		})
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {
			delete: kvDelete,
		},
		REPO_SESSION_INDEX: indexEnv.REPO_SESSION_INDEX,
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> & typeof indexEnv
	for (const [sourceId, publishedCommit] of [
		['source-current', 'commit-current'],
		['source-stale', 'commit-current'],
		['source-session', 'commit-current'],
	]) {
		await sql(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES (?, 'user-1', 'package', ?, ?, ?, ?, ?)`,
			sourceId,
			`pkg-${sourceId}`,
			`repo-${sourceId}`,
			publishedCommit,
			daysAgo(60),
			daysAgo(60),
		)
	}
	for (const [id, sourceId, commit, createdAt] of [
		[
			'artifact-delete',
			'source-stale',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
		[
			'artifact-current',
			'source-current',
			'commit-current',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
		[
			'artifact-fresh',
			'source-stale',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays),
		],
		[
			'artifact-session',
			'source-session',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
	]) {
		await sql(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, entry_point,
				kv_key, created_at, updated_at
			) VALUES (?, 'user-1', ?, ?, 'module', ?, ?, ?, ?)`,
			id,
			sourceId,
			commit,
			// One artifact per source identity (kind, name, entry point).
			`src/${id}.ts`,
			`kv:${id}`,
			createdAt,
			createdAt,
		)
	}

	const result = await prunePublishedBundleArtifactsForRetention({
		env,
		now,
		batchSize: 10,
	})

	expect(result).toEqual({
		deletedRows: 1,
		deletedKvKeys: 1,
		deletedSnapshotKvKeys: 2,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).toHaveBeenCalledWith('kv:artifact-delete')
	expect(kvDelete).toHaveBeenCalledWith(
		'source-snapshot:v1:source-stale:commit-old',
	)
	expect(kvDelete).toHaveBeenCalledWith(
		'source-manifest-snapshot:v1:source-stale:commit-old',
	)
	expect(await idsForTable(sql, 'published_bundle_artifacts')).toEqual([
		'artifact-current',
		'artifact-fresh',
		'artifact-session',
	])
})

test('published bundle artifact retention rechecks staleness before deleting selected rows', async () => {
	await using retention = await createRetentionDb()
	const { sql, retentionDb } = retention
	const kvDelete = vi.fn(async () => undefined)
	let refreshedBeforeDelete = false
	const dbWithRefreshRace = {
		...retentionDb,
		prepare(query: string) {
			const prepared = retentionDb.prepare(query)
			if (
				query.includes('DELETE FROM published_bundle_artifacts') &&
				query.includes('AND kv_key = ?')
			) {
				return {
					...prepared,
					bind(...params: Array<unknown>) {
						const bound = prepared.bind(...params)
						return {
							...bound,
							async run() {
								refreshedBeforeDelete = true
								await sql(`UPDATE entity_sources
										SET published_commit = 'commit-old'
										WHERE id = 'source-race'`)
								return bound.run()
							},
						} as typeof bound
					},
				} as typeof prepared
			}
			return prepared
		},
	} satisfies PgDatabase as unknown as D1Database
	const env = {
		APP_DB: dbWithRefreshRace,
		BUNDLE_ARTIFACTS_KV: {
			delete: kvDelete,
		},
		REPO_SESSION_INDEX:
			createInMemoryRepoSessionIndexEnv(dbWithRefreshRace).REPO_SESSION_INDEX,
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	await sql(
		`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES ('source-race', 'user-1', 'package', 'pkg-race', 'repo-race',
				'commit-current', ?, ?)`,
		daysAgo(60),
		daysAgo(60),
	)
	await sql(
		`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, entry_point,
				kv_key, created_at, updated_at
			) VALUES (
				'artifact-race', 'user-1', 'source-race', 'commit-old', 'module',
				'src/index.ts', 'kv:artifact-race', ?, ?
			)`,
		daysAgo(publishedBundleArtifactRetentionDays + 1),
		daysAgo(publishedBundleArtifactRetentionDays + 1),
	)

	const result = await prunePublishedBundleArtifactsForRetention({
		env,
		now,
		batchSize: 10,
	})

	expect(refreshedBeforeDelete).toBe(true)
	expect(result).toEqual({
		deletedRows: 0,
		deletedKvKeys: 0,
		deletedSnapshotKvKeys: 0,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).not.toHaveBeenCalled()
	expect(await idsForTable(sql, 'published_bundle_artifacts')).toEqual([
		'artifact-race',
	])
})

test('retention pruning deletes only one configured batch per table invocation', async () => {
	await using retention = await createRetentionDb()
	const { auditSql, auditDb } = retention
	for (let index = 0; index < 3; index += 1) {
		await insertAuditEvent(auditSql, {
			timestamp: daysAgo(auditEventRetentionDays + 1 + index),
		})
	}

	expect(
		await pruneAuditEventsForRetention({ db: auditDb, now, batchSize: 2 }),
	).toEqual({ selected: 2, deleted: 2 })
	expect(await idsForAuditEvents(auditSql)).toHaveLength(1)
	expect(
		await pruneAuditEventsForRetention({ db: auditDb, now, batchSize: 2 }),
	).toEqual({ selected: 1, deleted: 1 })
	expect(await idsForAuditEvents(auditSql)).toEqual([])
})

test('retention row deletes chunk ids to stay within the D1 binding limit', async () => {
	await using retention = await createRetentionDb()
	const { auditSql } = retention
	const auditDb = withMaxBindings(
		retention.auditDb as unknown as PgDatabase,
		100,
	) as unknown as D1Database
	for (let index = 0; index < 101; index += 1) {
		await insertAuditEvent(auditSql, {
			timestamp: daysAgo(auditEventRetentionDays + 1),
		})
	}

	expect(
		await pruneAuditEventsForRetention({ db: auditDb, now, batchSize: 101 }),
	).toEqual({ selected: 101, deleted: 101 })
	expect(await idsForAuditEvents(auditSql)).toEqual([])
})

test('retention run loops batches per table until backlogs are drained', async () => {
	await using retention = await createRetentionDb()
	const { sql, auditSql, db, auditDb } = retention
	for (let index = 0; index < 501; index += 1) {
		await insertPlatformFeedback(sql, {
			id: `feedback-${String(index).padStart(3, '0')}`,
			updatedAt: daysAgo(platformFeedbackRetentionDays + 1),
		})
	}
	for (let index = 0; index < 300; index += 1) {
		await insertAuditEvent(auditSql, {
			timestamp: daysAgo(auditEventRetentionDays + 1),
		})
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<
		Env,
		'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'
	>

	const result = await pruneRetention({ env, now })

	expect(result.platformFeedback).toBe(501)
	expect(result.auditEvents).toBe(300)
	expect(result.batchesPerTable['platform_feedback']).toBe(3)
	expect(result.batchesPerTable['audit_events']).toBe(2)
	expect(result.timeBudgetExhausted).toBe(false)
	expect(await idsForTable(sql, 'platform_feedback')).toEqual([])
	expect(await idsForAuditEvents(auditSql)).toEqual([])
})

test('retention run gives every table one batch and stops when the budget is exhausted', async () => {
	await using retention = await createRetentionDb()
	const { sql, auditSql, db, auditDb } = retention
	for (let index = 0; index < 300; index += 1) {
		await insertPlatformFeedback(sql, {
			id: `feedback-${String(index).padStart(3, '0')}`,
			updatedAt: daysAgo(platformFeedbackRetentionDays + 1),
		})
	}
	await insertAuditEvent(auditSql, {
		timestamp: daysAgo(auditEventRetentionDays + 1),
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<
		Env,
		'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'
	>

	const result = await pruneRetention({ env, now, timeBudgetMs: 0 })

	// The first round-robin pass always completes so a hot table cannot starve
	// the others, then the exhausted budget stops further passes.
	expect(result.platformFeedback).toBe(250)
	expect(result.auditEvents).toBe(1)
	expect(result.batchesPerTable['platform_feedback']).toBe(1)
	expect(result.timeBudgetExhausted).toBe(true)
	expect(await idsForTable(sql, 'platform_feedback')).toHaveLength(50)
})

test('retention coverage includes every live growth-pattern table or documented exemption', async () => {
	await using retention = await createRetentionDb()
	// Application and audit databases together.
	const columnRows = [
		...(await retention.sql(
			`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
		)),
		...(await retention.auditSql(
			`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
		)),
	] as Array<{ table_name: string; column_name: string }>
	const columnsByTable = new Map<string, Set<string>>()
	for (const row of columnRows) {
		columnsByTable.set(
			row.table_name,
			(columnsByTable.get(row.table_name) ?? new Set()).add(row.column_name),
		)
	}
	const tables = [...columnsByTable.keys()].map((name) => ({ name }))
	// Job rows belong to the jobs service (ADR 0016), which owns their retention.
	const jobsServiceTables = new Set(['jobs', 'archived_job_artifacts'])
	const candidateTables = new Set<string>()
	const growthPattern =
		/(?:_runs|_logs|_events|_invocations|_suppressions|_artifacts|_messages|_threads|_attachments|_rollups|_counters|_memories)$/u
	const growthTimeColumns = ['created_at', 'day', 'month']
	for (const table of tables) {
		if (jobsServiceTables.has(table.name)) continue
		const columnNames = columnsByTable.get(table.name) ?? new Set<string>()
		const hasUserCreatedGrowthShape =
			columnNames.has('user_id') &&
			growthTimeColumns.some((column) => columnNames.has(column)) &&
			growthPattern.test(table.name)
		const hasGlobalStripeWebhookShape =
			table.name === 'stripe_webhook_events' && columnNames.has('processed_at')
		const hasPlatformFeedbackGrowthShape =
			table.name === 'platform_feedback' &&
			columnNames.has('submitter_user_id') &&
			columnNames.has('updated_at')
		const hasAgentPackageConversationUsesGrowthShape =
			table.name === 'agent_package_conversation_uses' &&
			columnNames.has('user_id') &&
			columnNames.has('last_used_at')
		if (
			hasUserCreatedGrowthShape ||
			hasGlobalStripeWebhookShape ||
			hasPlatformFeedbackGrowthShape ||
			hasAgentPackageConversationUsesGrowthShape
		) {
			candidateTables.add(table.name)
		}
	}
	const covered = getRetentionPolicyCoverage()
	const missing = [...candidateTables].filter((table) => !covered.has(table))
	const stale = [...covered].filter(
		(table) =>
			!candidateTables.has(table) && !tables.some((row) => row.name === table),
	)

	expect(missing).toEqual([])
	expect(stale).toEqual([])
})

test('the retention roles only read and delete the pruned tables', async () => {
	await using retention = await createRetentionDb()
	const auditRetention = retention.auditDb as unknown as PgDatabase
	for (const [db, sql] of [
		[retention.retentionDb, `SELECT email FROM users`],
		[retention.retentionDb, `SELECT summary FROM mcp_memories`],
		[
			retention.retentionDb,
			`UPDATE usage_rollups SET event_count = 0 WHERE month < '2000-01'`,
		],
		[auditRetention, `SELECT email_hash FROM audit_events`],
		[auditRetention, `UPDATE audit_events SET reason = 'x' WHERE id = 0`],
	] as const) {
		await expect(db.prepare(sql).all()).rejects.toThrow(/permission denied/)
	}
})
