import { expect, test } from 'vitest'
import { type EmbeddingPort } from '#worker/aws/bedrock-embeddings.ts'
import {
	CAPABILITY_EMBEDDING_BATCH_SIZE,
	CAPABILITY_EMBEDDING_DIMENSIONS,
	CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
	createTextEmbeddingCache,
	deterministicEmbedding,
	embedTextsForVectorize,
} from './embedding.ts'

function portEnv(
	embedTexts: EmbeddingPort['embedTexts'],
	extra: Record<string, unknown> = {},
) {
	return {
		SENTRY_ENVIRONMENT: 'production',
		BEDROCK_EMBEDDINGS: { embedTexts },
		...extra,
	} as unknown as Env
}

test('embedding wrapper sends bounded, truncated batches to the Bedrock port in order', async () => {
	const calls: Array<Array<string>> = []
	const env = portEnv(async (texts) => {
		calls.push([...texts])
		return texts.map((text) => deterministicEmbedding(text))
	})
	const texts = [
		'x'.repeat(CAPABILITY_EMBEDDING_MAX_INPUT_CHARS + 500),
		...Array.from(
			{ length: CAPABILITY_EMBEDDING_BATCH_SIZE },
			(_, index) => `text-${index}`,
		),
	]

	await expect(embedTextsForVectorize(env, [])).resolves.toEqual([])
	expect(calls).toEqual([])

	const rows = await embedTextsForVectorize(env, texts)
	expect(calls.map((batch) => batch.length)).toEqual([
		CAPABILITY_EMBEDDING_BATCH_SIZE,
		1,
	])
	expect(calls[0]![0]).toHaveLength(CAPABILITY_EMBEDDING_MAX_INPUT_CHARS)
	expect(rows).toEqual(
		texts.map((text) =>
			deterministicEmbedding(
				text.slice(0, CAPABILITY_EMBEDDING_MAX_INPUT_CHARS),
			),
		),
	)
	expect(rows.every((row) => row.length === 1024)).toBe(true)
	expect(CAPABILITY_EMBEDDING_DIMENSIONS).toBe(1024)
})

test('embedding wrapper rejects port failures and misaligned or wrong-sized rows', async () => {
	await expect(
		embedTextsForVectorize(
			portEnv(async () => {
				throw new Error('bedrock unavailable')
			}),
			['alpha'],
		),
	).rejects.toThrow(/bedrock unavailable/)
	await expect(
		embedTextsForVectorize(
			portEnv(async () => [deterministicEmbedding('alpha')]),
			['alpha', 'beta'],
		),
	).rejects.toThrow(/row count mismatch/)
	await expect(
		embedTextsForVectorize(
			portEnv(async (texts) => texts.map(() => [0.1, 0.2])),
			['alpha'],
		),
	).rejects.toThrow(/dimension mismatch/)
})

test('embedding wrapper falls back deterministically only outside production', async () => {
	await expect(
		embedTextsForVectorize({ SENTRY_ENVIRONMENT: 'preview' } as Env, [
			'alpha',
			'beta',
		]),
	).resolves.toEqual([
		deterministicEmbedding('alpha'),
		deterministicEmbedding('beta'),
	])
	await expect(
		embedTextsForVectorize({ SENTRY_ENVIRONMENT: 'production' } as Env, [
			'alpha',
		]),
	).rejects.toThrow(/BEDROCK_EMBEDDINGS/)
})

test('createTextEmbeddingCache embeds each distinct text once and shares the pending promise', async () => {
	const texts: Array<Array<string>> = []
	const env = portEnv(async (input) => {
		texts.push([...input])
		return input.map((text) => deterministicEmbedding(text))
	})
	const cache = createTextEmbeddingCache(env)

	const [first, again, other] = await Promise.all([
		cache.embedText('summarize inbox threads'),
		cache.embedText('summarize inbox threads'),
		cache.embedText('draft an email'),
	])

	expect(texts).toEqual([['summarize inbox threads'], ['draft an email']])
	expect(first).toEqual(again)
	expect(first).not.toEqual(other)
})
