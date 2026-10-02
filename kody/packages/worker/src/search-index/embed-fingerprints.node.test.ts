import { PGlite } from '@electric-sql/pglite'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createPgSearchIndex } from '#worker/aws/pg-search-index.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	canonicalizeVectorEmbedMetadata,
	recordVectorEmbedFingerprint,
	shouldSkipVectorEmbed,
	tryDeleteVectorEmbedFingerprint,
	tryReadVectorEmbedFingerprints,
	tryWriteVectorEmbedFingerprints,
	vectorEmbedContentHash,
	vectorEmbedFingerprintVersion,
} from './embed-fingerprints.ts'
import * as embedding from './embedding.ts'
import { reindexVectorCandidates } from './reindex-batches.ts'
import { BUILTIN_VECTOR_NAMESPACE } from './vector-namespaces.ts'

function countingEmbeddings() {
	const calls: Array<Array<string>> = []
	return {
		calls,
		port: {
			async embedTexts(texts: readonly string[]) {
				calls.push([...texts])
				return texts.map((text) => embedding.deterministicEmbedding(text))
			},
		},
	}
}

test('vector embed fingerprints skip unchanged text per owner and force rebuilds the pgvector index', async () => {
	const { pg, forUser } = await createTestDb()
	try {
		const me = forUser('user-me')
		const other = forUser('user-other')
		const embeddings = countingEmbeddings()
		const env = {
			APP_DB: me.db,
			BEDROCK_EMBEDDINGS: embeddings.port,
		} as unknown as Env
		const index = createPgSearchIndex({ ...me, userId: 'user-me' })
		const builtinDb = createPgDatabase({
			connection: pg,
			role: 'kody_indexer',
			userId: BUILTIN_VECTOR_NAMESPACE,
		})
		const builtinEnv = {
			APP_DB: builtinDb,
			BEDROCK_EMBEDDINGS: embeddings.port,
		} as unknown as Env
		const builtinIndex = createPgSearchIndex({
			db: builtinDb,
			reader: builtinDb,
			userId: BUILTIN_VECTOR_NAMESPACE,
		})
		const builtin = {
			id: 'search_memories',
			text: 'search memories capability',
			namespace: BUILTIN_VECTOR_NAMESPACE,
			metadata: { kind: 'builtin' },
		}
		const memory = {
			id: 'memory-1',
			text: 'remember the preview locale',
			namespace: 'user-me',
			metadata: { kind: 'memory' },
		}

		const hash = await vectorEmbedContentHash(builtin)
		await expect(
			sha256Hex(
				[
					embedding.CAPABILITY_EMBEDDING_MODEL,
					String(embedding.CAPABILITY_EMBEDDING_DIMENSIONS),
					String(vectorEmbedFingerprintVersion),
					builtin.text,
					canonicalizeVectorEmbedMetadata(builtin.metadata),
				].join('\0'),
			),
		).resolves.toBe(hash)
		const longPrefix = 'x'.repeat(
			embedding.CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
		)
		await expect(
			vectorEmbedContentHash({ text: `${longPrefix}tail-a` }),
		).resolves.toBe(
			await vectorEmbedContentHash({ text: `${longPrefix}tail-b` }),
		)

		const run = (candidates: Array<typeof memory>, force?: boolean) =>
			reindexVectorCandidates({ env, index, kind: 'test', candidates, force })
		await expect(
			reindexVectorCandidates({
				env: builtinEnv,
				index: builtinIndex,
				kind: 'builtin',
				candidates: [builtin],
			}),
		).resolves.toEqual({ upserted: 1 })
		await expect(run([memory])).resolves.toEqual({ upserted: 1 })
		expect(embeddings.calls).toEqual([[builtin.text], [memory.text]])
		expect((await index.getByIds(['memory-1']))[0]?.metadata).toEqual({
			kind: 'memory',
		})

		embeddings.calls.length = 0
		await expect(
			reindexVectorCandidates({
				env: builtinEnv,
				index: builtinIndex,
				kind: 'builtin',
				candidates: [builtin],
			}),
		).resolves.toEqual({ upserted: 0, skipped: 1 })
		await expect(run([memory])).resolves.toEqual({ upserted: 0, skipped: 1 })
		await expect(run([memory], true)).resolves.toEqual({ upserted: 1 })
		expect(embeddings.calls).toEqual([[memory.text]])

		embeddings.calls.length = 0
		const changedMetadata = {
			...memory,
			text: 'remember a different locale',
			metadata: { kind: 'memory', status: 'deleted' },
		}
		await expect(run([changedMetadata])).resolves.toEqual({ upserted: 1 })
		expect(embeddings.calls).toEqual([[changedMetadata.text]])
		expect((await index.getByIds(['memory-1']))[0]?.metadata).toEqual(
			changedMetadata.metadata,
		)
		await expect(
			shouldSkipVectorEmbed({
				env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: changedMetadata.text,
				metadata: { kind: 'memory' },
			}),
		).resolves.toBe(false)

		// Fingerprints follow owner RLS: another account neither sees nor removes them.
		const otherEnv = { APP_DB: other.db } as unknown as Env
		await recordVectorEmbedFingerprint({
			env: otherEnv,
			userId: 'user-other',
			vectorId: 'memory-1',
			text: 'other account memory',
		})
		await expect(
			tryReadVectorEmbedFingerprints({
				env: otherEnv,
				keys: [
					{ userId: 'user-me', vectorId: 'memory-1' },
					{ userId: BUILTIN_VECTOR_NAMESPACE, vectorId: builtin.id },
				],
			}),
		).resolves.toEqual(new Map())
		await tryWriteVectorEmbedFingerprints({
			env: otherEnv,
			rows: [{ userId: 'user-me', vectorId: 'forged', contentHash: 'abc' }],
		})
		await expect(
			tryReadVectorEmbedFingerprints({
				env,
				keys: [{ userId: 'user-me', vectorId: 'forged' }],
			}),
		).resolves.toEqual(new Map())
		await tryDeleteVectorEmbedFingerprint({ env, vectorId: 'memory-1' })
		await expect(
			shouldSkipVectorEmbed({
				env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: changedMetadata.text,
				metadata: changedMetadata.metadata,
			}),
		).resolves.toBe(false)
		await expect(
			shouldSkipVectorEmbed({
				env: otherEnv,
				userId: 'user-other',
				vectorId: 'memory-1',
				text: 'other account memory',
			}),
		).resolves.toBe(true)
		await expect(
			shouldSkipVectorEmbed({
				env: {} as Env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: memory.text,
			}),
		).resolves.toBe(false)

		const bare = new PGlite()
		try {
			const unmigratedEnv = {
				APP_DB: createPgDatabase({
					connection: bare,
					role: 'kody_writer',
					userId: 'user-me',
				}),
			} as unknown as Env
			await expect(
				tryReadVectorEmbedFingerprints({
					env: unmigratedEnv,
					keys: [{ userId: 'user-me', vectorId: 'memory-1' }],
				}),
			).resolves.toBeNull()
			await tryWriteVectorEmbedFingerprints({
				env: unmigratedEnv,
				rows: [{ userId: 'user-me', vectorId: 'memory-1', contentHash: 'abc' }],
			})
			await tryDeleteVectorEmbedFingerprint({
				env: unmigratedEnv,
				vectorId: 'memory-1',
			})
		} finally {
			await bare.close()
		}
	} finally {
		await pg.close()
	}
})
