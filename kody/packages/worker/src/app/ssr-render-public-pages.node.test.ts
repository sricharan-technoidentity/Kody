import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createDiscordHandler } from '#app/handlers/discord.ts'
import { createFaqHandler } from '#app/handlers/faq.ts'
import { createSupportHandler } from '#app/handlers/support.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createTestEnv(db: PgDatabase) {
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_KMS: testSecretKms,
		...testOidcSigningEnv,
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
}

test('renderAppPage renders the public FAQ page for anonymous visitors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = createTestEnv(store.db)

	const response = await createFaqHandler(env).handler({
		request: new Request('https://example.com/faq'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('<title>FAQ</title>')
	expect(html).toContain('data-faq="replace-agents"')
	expect(html).toContain('data-faq="shared-account"')
	expect(html).toContain('mailto:support@kody.codes')
	expect(html).toContain('<details')
	expect(html).toContain('<summary>')
	expect(html).toContain('href="/faq">FAQ</a>')
	expect(html).toContain('data-faq="get-started"')
	expect(html).toContain('Create a free account from')
	expect(html).toContain('href="/signup"')
})

test('renderAppPage renders the public support page for anonymous visitors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = createTestEnv(store.db)

	const response = await createSupportHandler(env).handler({
		request: new Request('https://example.com/support'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('<title>Support</title>')
	expect(html).toContain('mailto:support@kody.codes')
	expect(html).toContain('support@kody.codes')
	expect(html).toContain('href="/support">Support</a>')
})

test('renderAppPage renders the public Discord connect page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = {
		...createTestEnv(store.db),
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
	} as Env

	const response = await createDiscordHandler(env).handler({
		request: new Request('https://example.com/discord'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('Connect Discord')
	expect(html).toContain('<title>Discord</title>')
	const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0]
	expect(heading).toContain('Discord')
	const connectButtons = (
		html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
	).filter((button) => button.includes('Connect Discord'))
	expect(connectButtons).toHaveLength(1)
})
