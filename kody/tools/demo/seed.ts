import { type createFrontDoorTestEnv } from '#worker/test-support/front-door.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { upsertMemory } from '#mcp/memory/service.ts'
import {
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
} from '#worker/webhooks/service.ts'

export const demoUsers = {
	alice: {
		email: 'alice@example.invalid',
		username: 'alice',
		password: 'demo-password-123',
	},
	bob: {
		email: 'bob@example.invalid',
		username: 'bob',
		password: 'demo-password-123',
	},
}

export async function seedDemo(
	env: Awaited<ReturnType<typeof createFrontDoorTestEnv>>,
	fixture: { commit: string; files: Record<string, string> },
) {
	env.bindings.CLOUDFLARE_API_SOURCE_SNAPSHOTS = 'false'
	for (const user of Object.values(demoUsers)) await env.seedUser(user)
	const aliceId = await createStableUserIdFromEmail(demoUsers.alice.email)
	const bobId = await createStableUserIdFromEmail(demoUsers.bob.email)
	const owner = await env.env.forUser(aliceId, true)
	owner.CLOUDFLARE_API_SOURCE_SNAPSHOTS = 'false'
	await upsertMemory({
		env: owner,
		userId: aliceId,
		userEmail: demoUsers.alice.email,
		memoryId: null,
		category: 'preference',
		subject: 'POC report preference',
		summary: 'Alice prefers concise synthetic reports.',
		details: 'Approved synthetic presenter fixture.',
		tags: ['demo'],
		sourceUris: [],
		dedupeKey: 'demo-preference',
		status: 'active',
		verificationReference: 'demo-seed-approved',
	})
	const api = `${env.mockOrigin}/client/v4/accounts/000000000000/artifacts/namespaces/test/repos`
	const response = await fetch(api, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'demo-report', default_branch: 'main' }),
	})
	if (!response.ok) throw new Error('Demo source fixture registration failed.')
	const packageId = crypto.randomUUID()
	const now = new Date().toISOString()
	const source: EntitySourceRow = {
		id: crypto.randomUUID(),
		user_id: aliceId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: 'demo-report',
		published_commit: fixture.commit,
		indexed_commit: fixture.commit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	await insertSavedPackage(owner.APP_DB, {
		id: packageId,
		user_id: aliceId,
		name: '@alice/report',
		kody_id: 'report',
		description: 'Synthetic POC report',
		tags_json: '["demo"]',
		search_text: 'Synthetic POC report',
		source_id: source.id,
		has_app: 1,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(owner.APP_DB, source)
	await writePublishedSourceSnapshot({
		env: owner,
		source,
		files: fixture.files,
	})
	await refreshSavedPackageProjection({
		env: owner,
		baseUrl: owner.APP_BASE_URL!,
		userId: aliceId,
		userEmail: demoUsers.alice.email,
		packageId,
		sourceId: source.id,
		sourceFiles: fixture.files,
	})
	const minted = await mintWebhookUrlForUser({
		env: owner,
		userId: aliceId,
		email: demoUsers.alice.email,
		username: 'alice',
		packageId,
		webhookName: 'report',
	})
	const revealed = await revealWebhookUrlForWebsite({
		env: owner,
		userId: aliceId,
		email: demoUsers.alice.email,
		username: 'alice',
		target: { handle: minted.handle },
	})
	return { aliceId, bobId, packageId, webhookUrl: revealed.url }
}
