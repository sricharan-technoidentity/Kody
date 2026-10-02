import { expect, test } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { storeFrozenKey } from './frozen-keys.ts'

// Independent examples from architecture/data-storage.md, sections "Durable Object id contracts"
// through "Vectorize metadata contracts". Keep the literal strings during adapter rewrites.
const frozenKeys = [
	['dynamo', 'source-snapshot:v1:source:commit'],
	['dynamo', 'source-manifest-snapshot:v1:source:commit'],
	['dynamo', 'bundle-artifact:v1:source:commit:export:_:main'],
	['dynamo', 'community-snapshot:v1:listing'],
	['dynamo', 'package-retriever-manifest:v1:alice:pkg:revision'],
	['dynamo', 'package-retriever-index-entry:v1:alice:scope:pkg:key'],
	['dynamo', 'derived-cache:v1:mcp-oauth-refresh-family:alice:grant'],
	['dynamo', 'derived-cache:v1:mcp-oauth-refresh-replay:alice:grant:hash'],
	['dynamo', 'derived-cache:v1:usage-rollups:user:alice:asof:2026-09'],
	['dynamo', 'derived-cache:v1:community-icon:v3:listing:commit'],
	['dynamo', 'derived-cache:v1:identity-icon:v1:repo:commit'],
	['dynamo', 'derived-cache:v1:artifact-head:v1:namespace:repo'],
	['dynamo', 'webhook-dispatch-payload:v1:alice:delivery'],
	['dynamo', 'platform-settings:v1:reserved-usernames'],
	['s3', 'community-icon:v3/listing/commit/asset'],
	['s3', 'identity-icon:v1/repo/commit/asset'],
	['s3', 'user-avatars/alice/hash.webp'],
	['s3', 'email-raw:v1:alice/message'],
	['s3', 'email-attachment:v1:alice/message/attachment'],
	['s3', 'repo-session:durable-id/file'],
	['postgres', 'alice'], // JobManager, RunLog, UserMeter, StripePlanRefresh, Mailbox, RepoSessionIndex
	['postgres', 'alice'.trim()], // McpClientHub
	['postgres', JSON.stringify(['alice', 'storage'])], // StorageRunner
	['postgres', 'session-id'], // RepoSession
	['postgres', JSON.stringify(['alice', 'package'])], // PackageRealtimeSession
	['postgres', 'exec:uuid'],
	['postgres', 'job:job-id'],
	['postgres', 'job:package-job:package-id:daily'],
	['postgres', 'package:package-id'],
	['postgres', 'package-id:facet:main'],
	['postgres', 'package-id:export:name'],
	['postgres', 'a'.repeat(64)], // User-owned Vectorize namespace
	['postgres', 'memory_memory-id'],
	['postgres', 'job_job-id'],
	['postgres', 'job_sha256:0123456789abcdef'],
	['postgres', 'package_package-id'],
	['postgres', 'package_sha256:0123456789abcdef'],
	['postgres', 'capability.name'], // Builtin Vectorize id
	['postgres', '__kody_builtin__'], // Vectorize builtin namespace
] as const

const vectorMetadata = [
	[
		'memory_memory-id',
		{ kind: 'memory', userId: 'alice', status: 'active', category: 'note' },
	],
	['job_job-id', { kind: 'job', userId: 'alice' }],
	['package_package-id', { kind: 'package', userId: 'alice' }],
	['capability.name', { kind: 'builtin', domain: 'search' }],
] as const

test('new adapters preserve every documented frozen key byte for byte', async () => {
	expect.assertions(frozenKeys.length + vectorMetadata.length)
	const { env, close } = await createTargetTestEnv()
	try {
		for (const [home, key] of frozenKeys) {
			const value = new TextEncoder().encode(key)
			await storeFrozenKey({ env, home, key, value })
			if (home === 's3') expect(env.objects.get(key)).toEqual(value)
			if (home === 'dynamo')
				expect(env.kv.get(key, 'value')?.value).toEqual(value)
			if (home === 'postgres')
				expect(
					await env.db
						.prepare('SELECT value FROM isolation_probe WHERE id = ?')
						.bind(key)
						.first('value'),
				).toBe(key)
		}
		for (const [key, metadata] of vectorMetadata) {
			const value = JSON.stringify(metadata)
			await storeFrozenKey({
				env,
				home: 'postgres',
				key,
				value: new TextEncoder().encode(value),
			})
			expect(
				await env.db
					.prepare('SELECT value FROM isolation_probe WHERE id = ?')
					.bind(key)
					.first('value'),
			).toBe(value)
		}
	} finally {
		await close()
	}
})
