import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'
import { type EmbeddingPort } from '#worker/aws/bedrock-embeddings.ts'
import { type createPgSearchIndex } from '#worker/aws/pg-search-index.ts'

/**
 * Bedrock embedding and search index access for every corpus that shares the
 * index (builtin capabilities, saved packages, memories, jobs). Lives outside
 * `#mcp/*` because non-MCP subsystems — the package registry, community
 * search, job reindexing — embed and query the same index, and used to reach
 * into `#mcp/capabilities/capability-search.ts` to do it.
 *
 * The `CAPABILITY_` name prefix refers to that shared index, not to builtin
 * capabilities specifically.
 */

export type SearchIndex = ReturnType<typeof createPgSearchIndex>

type SearchRuntimeEnv = {
	BEDROCK_EMBEDDINGS?: EmbeddingPort
	SEARCH_INDEX?: SearchIndex
	CAPABILITY_VECTOR_INDEX?: SearchIndex
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

export function getCapabilityVectorIndex(env: Env): SearchIndex | undefined {
	const runtime = env as unknown as SearchRuntimeEnv
	// ponytail: legacy CAPABILITY_VECTOR_INDEX test doubles still satisfy the
	// pgvector shape; drop the fallback when P7 replaces Env with AwsEnv.
	return runtime.SEARCH_INDEX ?? runtime.CAPABILITY_VECTOR_INDEX
}

/** Must match `search_vectors.embedding` (Titan v2, normalized). */
export const CAPABILITY_EMBEDDING_DIMENSIONS = 1024
// ponytail: fingerprints hash this constant, so it must equal
// BEDROCK_EMBEDDING_MODEL_ID; expose the model on EmbeddingPort if they diverge.
export const CAPABILITY_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
/** Concurrent Bedrock requests per batch (Titan embeds one text per request). */
export const CAPABILITY_EMBEDDING_BATCH_SIZE = 8
export const CAPABILITY_EMBEDDING_MAX_INPUT_CHARS = 2_000

export function truncateEmbeddingInput(text: string) {
	if (text.length <= CAPABILITY_EMBEDDING_MAX_INPUT_CHARS) return text
	return text.slice(0, CAPABILITY_EMBEDDING_MAX_INPUT_CHARS)
}

/**
 * L2-normalized pseudo-embedding for offline / test search (no Bedrock call).
 */
export function deterministicEmbedding(
	text: string,
	dimensions: number = CAPABILITY_EMBEDDING_DIMENSIONS,
): number[] {
	const normalized = text.toLowerCase().trim()
	const vec = new Float64Array(dimensions)
	for (let i = 0; i < dimensions; i += 1) {
		const h = fnv1a32(`${normalized}:${i}`)
		vec[i] = h / 2 ** 32 - 0.5
	}
	let norm = 0
	for (let i = 0; i < dimensions; i += 1) norm += vec[i]! * vec[i]!
	norm = Math.sqrt(norm) || 1
	for (let i = 0; i < dimensions; i += 1) vec[i]! /= norm
	return [...vec]
}

export function isCapabilitySearchOffline(env: Env): boolean {
	const runtime = env as unknown as Record<string, string | undefined>
	if (runtime['SENTRY_ENVIRONMENT'] === 'test') return true
	if (runtime['WRANGLER_IS_LOCAL_DEV'] === 'true') return true
	if (
		!getCapabilityVectorIndex(env) &&
		runtime['SENTRY_ENVIRONMENT'] !== 'production'
	)
		return true
	return false
}

export async function embedTextForVectorize(
	env: Env,
	text: string,
): Promise<Array<number>> {
	const rows = await embedTextsForVectorize(env, [text])
	return rows[0]!
}

export type EmbedTextFn = (text: string) => Promise<Array<number>>

export function createTextEmbeddingCache(env: Env): {
	embedText: EmbedTextFn
} {
	const pending = new Map<string, Promise<Array<number>>>()
	return {
		embedText(text) {
			const cached = pending.get(text)
			if (cached) return cached
			const promise = embedTextForVectorize(env, text)
			pending.set(text, promise)
			return promise
		},
	}
}

export async function embedTextsForVectorize(
	env: Env,
	texts: ReadonlyArray<string>,
): Promise<Array<Array<number>>> {
	if (texts.length === 0) return []
	const truncatedTexts = texts.map((text) => truncateEmbeddingInput(text))

	const runtime = env as unknown as SearchRuntimeEnv
	const port = runtime.BEDROCK_EMBEDDINGS
	if (!port) {
		if (runtime.SENTRY_ENVIRONMENT !== 'production') {
			return truncatedTexts.map((text) => deterministicEmbedding(text))
		}
		throw new Error(
			'BEDROCK_EMBEDDINGS is required for capability embeddings in production.',
		)
	}

	const rows: Array<Array<number>> = []
	for (
		let offset = 0;
		offset < truncatedTexts.length;
		offset += CAPABILITY_EMBEDDING_BATCH_SIZE
	) {
		const batch = truncatedTexts.slice(
			offset,
			offset + CAPABILITY_EMBEDDING_BATCH_SIZE,
		)
		const embedded = await port.embedTexts(batch)
		if (embedded.length !== batch.length) {
			throw new Error(
				`Embedding response row count mismatch: expected ${batch.length}, received ${embedded.length}.`,
			)
		}
		for (const row of embedded) {
			if (row.length !== CAPABILITY_EMBEDDING_DIMENSIONS) {
				throw new Error(
					`Embedding dimension mismatch: expected ${CAPABILITY_EMBEDDING_DIMENSIONS}, received ${row.length}.`,
				)
			}
		}
		rows.push(...embedded)
	}
	return rows
}
