import { type PgDatabase } from './pg-database.ts'

type Vector = {
	id: string
	namespace?: string
	values: number[]
	metadata?: Record<string, unknown>
	text?: string
}
type Match = {
	id: string
	score: number
	metadata?: Record<string, unknown>
	values?: number[]
}
type QueryOptions = {
	namespace?: string
	topK?: number
	returnMetadata?: 'all' | 'indexed' | 'none'
	returnValues?: boolean
	filter?: Record<string, unknown>
}
const builtinNamespace = '__kody_builtin__'
const dimensions = 1024

function serializedVector(values: number[]) {
	if (
		values.length !== dimensions ||
		values.some((value) => !Number.isFinite(value))
	)
		throw new Error(`embedding must have ${dimensions} finite dimensions`)
	return JSON.stringify(values)
}

function filterSql(filter: Record<string, unknown> = {}) {
	const predicates: string[] = []
	const values: unknown[] = []
	for (const [key, condition] of Object.entries(filter)) {
		const operators: [string, unknown][] =
			typeof condition === 'object' &&
			condition !== null &&
			!Array.isArray(condition)
				? Object.entries(condition)
				: [['$eq', condition]]
		for (const [operator, value] of operators) {
			if (!['$eq', '$ne', '$in', '$nin'].includes(operator))
				throw new Error('unsupported metadata filter')
			if (operator === '$in' || operator === '$nin') {
				if (!Array.isArray(value))
					throw new Error('metadata membership filter requires an array')
				predicates.push(
					`${operator === '$nin' ? 'NOT ' : ''}(metadata_json -> ? IN (SELECT value FROM jsonb_array_elements(?::jsonb)))`,
				)
				values.push(key, JSON.stringify(value))
			} else {
				predicates.push(
					`metadata_json -> ? ${operator === '$ne' ? '<>' : '='} ?::jsonb`,
				)
				values.push(key, JSON.stringify(value))
			}
		}
	}
	return {
		sql: predicates.length ? ' AND ' + predicates.join(' AND ') : '',
		values,
	}
}

export function createPgSearchIndex(input: {
	db: PgDatabase
	reader: PgDatabase
	userId: string
}) {
	if (!input.userId) throw new Error('userId is required')
	function namespace(requested = input.userId, writable = false) {
		if (
			requested !== input.userId &&
			(writable || requested !== builtinNamespace)
		)
			throw new Error('cross-user vector namespace')
		return requested
	}
	function limit(topK = 20) {
		if (!Number.isInteger(topK) || topK < 1 || topK > 100)
			throw new Error('topK must be between 1 and 100')
		return topK
	}
	return {
		async upsert(vectors: Vector[]) {
			const statements = vectors.map((vector) =>
				input.db
					.prepare(`INSERT INTO search_vectors (user_id, id, embedding, metadata_json, search_text)
				VALUES (?, ?, ?::vector, ?::jsonb, ?) ON CONFLICT (user_id, id) DO UPDATE SET embedding = excluded.embedding, metadata_json = excluded.metadata_json, search_text = excluded.search_text`)
					.bind(
						namespace(vector.namespace, true),
						vector.id,
						serializedVector(vector.values),
						JSON.stringify(vector.metadata ?? {}),
						vector.text ?? String(vector.metadata?.text ?? ''),
					),
			)
			await input.db.batch(statements)
			return { count: vectors.length, ids: vectors.map((vector) => vector.id) }
		},
		async query(values: number[], options: QueryOptions = {}) {
			const filter = filterSql(options.filter)
			const result = await input.reader
				.prepare(`SELECT id, 1 - (embedding <=> ?::vector) AS score, metadata_json, embedding::text AS values_json
				FROM search_vectors WHERE user_id = ? ${filter.sql} ORDER BY embedding <=> ?::vector, id LIMIT ?`)
				.bind(
					serializedVector(values),
					namespace(options.namespace),
					...filter.values,
					serializedVector(values),
					limit(options.topK),
				)
				.all<{
					id: string
					score: number
					metadata_json: Record<string, unknown>
					values_json: string
				}>()
			const matches: Match[] = result.results.map((row) => ({
				id: row.id,
				score: row.score,
				...(options.returnMetadata && options.returnMetadata !== 'none'
					? { metadata: row.metadata_json }
					: {}),
				...(options.returnValues
					? { values: JSON.parse(row.values_json) as number[] }
					: {}),
			}))
			return { count: matches.length, matches }
		},
		async fullText(query: string, options: QueryOptions = {}) {
			const filter = filterSql(options.filter)
			const result = await input.reader
				.prepare(`SELECT id, ts_rank_cd(search_document, websearch_to_tsquery('english', ?)) AS score
				FROM search_vectors WHERE user_id = ? AND search_document @@ websearch_to_tsquery('english', ?) ${filter.sql} ORDER BY score DESC, id LIMIT ?`)
				.bind(
					query,
					namespace(options.namespace),
					query,
					...filter.values,
					limit(options.topK),
				)
				.all<{ id: string; score: number }>()
			return result.results
		},
		async getByIds(ids: string[]) {
			if (!ids.length) return []
			const result = await input.reader
				.prepare(
					`SELECT id, embedding::text AS values_json, metadata_json FROM search_vectors WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`,
				)
				.bind(input.userId, ...ids)
				.all<{
					id: string
					values_json: string
					metadata_json: Record<string, unknown>
				}>()
			return result.results.map((row) => ({
				id: row.id,
				namespace: input.userId,
				values: JSON.parse(row.values_json) as number[],
				metadata: row.metadata_json,
			}))
		},
		async deleteByIds(ids: string[]) {
			if (!ids.length) return { count: 0, ids: [] }
			const result = await input.db
				.prepare(
					`DELETE FROM search_vectors WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
				)
				.bind(input.userId, ...ids)
				.run()
			return { count: result.meta.changes, ids }
		},
	}
}
