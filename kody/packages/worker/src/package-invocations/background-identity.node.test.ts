import { createRunnerTestEnv } from '#worker/test-support/runner.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { expect, test, vi } from 'vitest'
import { runSavedPackageModuleOnce } from './module-execution.ts'

test('subscription execution exposes the owner account identity to metaGetCurrentUser', async () => {
	const userId = 'a'.repeat(64)
	const email = 'subscription-owner@example.com'
	const displayName = 'Subscription Owner'
	silenceIncidentalRuntimeWarnings()
	const harness = await createRunnerTestEnv()
	await using cleanup = { [Symbol.asyncDispose]: harness.close }
	const { env } = harness
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username,
			email,
			display_name,
			password_hash,
			stable_user_id, email_verified_at
		) VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
	)
		.bind(
			'subscription-owner',
			email,
			displayName,
			'test-password-hash',
			userId,
		)
		.run()

	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId,
		entryPoint: 'entry.ts',
		sourceFiles: {
			'entry.ts': `import {kody} from 'kody:runtime'; export default async function main() { return kody.metaGetCurrentUser({}) }`,
		},
	})
	const preloadedModuleArtifact = {
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: bundle.mainModule,
			modules: bundle.modules,
			dependencies: [],
			packageContext: {
				packageId: 'package-1',
				kodyId: 'article-to-audio',
				sourceId: 'source-1',
			},
			createdAt: '2026-08-08T00:00:00.000Z',
		},
		source: {
			id: 'source-1',
			user_id: userId,
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-08-08T00:00:00.000Z',
			updated_at: '2026-08-08T00:00:00.000Z',
		},
	}

	const outcome = await runSavedPackageModuleOnce({
		env,
		preloadedModuleArtifact: preloadedModuleArtifact as never,
		baseUrl: 'https://kody.dev',
		actor: {
			tokenId: 'internal:email-subscriptions',
			userId,
		},
		savedPackage: {
			id: 'package-1',
			userId,
			name: '@example/article-to-audio',
			kodyId: 'article-to-audio',
			description: 'Article to audio',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: true,
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
		},
		invocationName: 'subscription:email.message.received',
		moduleSelector: {
			kind: 'subscription',
			topic: 'email.message.received',
		},
		params: { event: 'email.message.received' },
		idempotencyKey: null,
		invocationId: null,
		source: 'email',
		topic: 'email.message.received',
		notFoundCode: 'subscription_not_found',
		toolFactories: {
			createPackageRuntimeInvokeTools: vi.fn(() => ({}) as never),
			createPackageEventTools: vi.fn(() => ({}) as never),
		},
	})

	expect(outcome).toMatchObject({
		kind: 'completed',
		response: {
			status: 200,
			body: {
				result: {
					user_id: userId,
					email,
					display_name: displayName,
				},
			},
		},
	})
}, 60_000)
