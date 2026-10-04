import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { runSqlWithRetry } from '#worker/sql-retry.ts'

export type EntitySourceArtifactsPushSubscriptionRow = {
	source_id: string
	user_id: string
	repo_id: string
	subscription_id: string
	created_at: string
	updated_at: string
}

function mapRow(
	row: Record<string, unknown>,
): EntitySourceArtifactsPushSubscriptionRow {
	return {
		source_id: String(row['source_id']),
		user_id: String(row['user_id']),
		repo_id: String(row['repo_id']),
		subscription_id: String(row['subscription_id']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

export async function getArtifactsPushSubscriptionBySourceId(
	db: SqlDatabase,
	sourceId: string,
): Promise<EntitySourceArtifactsPushSubscriptionRow | null> {
	try {
		const result = await db
			.prepare(
				`SELECT * FROM entity_source_artifacts_push_subscriptions
				WHERE source_id = ?
				LIMIT 1`,
			)
			.bind(sourceId)
			.first<Record<string, unknown>>()
		return result ? mapRow(result) : null
	} catch (error) {
		if (
			error instanceof Error &&
			((error as { code?: string }).code === '42P01' ||
				error.message.includes(
					'no such table: entity_source_artifacts_push_subscriptions',
				))
		) {
			return null
		}
		throw error
	}
}

export async function upsertArtifactsPushSubscription(
	db: SqlDatabase,
	row: EntitySourceArtifactsPushSubscriptionRow,
): Promise<void> {
	await runSqlWithRetry(() =>
		db
			.prepare(
				`INSERT INTO entity_source_artifacts_push_subscriptions (
					source_id, user_id, repo_id, subscription_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(source_id) DO UPDATE SET
					user_id = excluded.user_id,
					repo_id = excluded.repo_id,
					subscription_id = excluded.subscription_id,
					updated_at = excluded.updated_at`,
			)
			.bind(
				row.source_id,
				row.user_id,
				row.repo_id,
				row.subscription_id,
				row.created_at,
				row.updated_at,
			)
			.run(),
	)
}

export async function deleteArtifactsPushSubscriptionBySourceId(
	db: SqlDatabase,
	input: { sourceId: string; userId: string },
): Promise<boolean> {
	try {
		const result = await runSqlWithRetry(() =>
			db
				.prepare(
					`DELETE FROM entity_source_artifacts_push_subscriptions
					WHERE source_id = ? AND user_id = ?`,
				)
				.bind(input.sourceId, input.userId)
				.run(),
		)
		return (result.meta.changes ?? 0) > 0
	} catch (error) {
		if (
			error instanceof Error &&
			((error as { code?: string }).code === '42P01' ||
				error.message.includes(
					'no such table: entity_source_artifacts_push_subscriptions',
				))
		) {
			return false
		}
		throw error
	}
}
