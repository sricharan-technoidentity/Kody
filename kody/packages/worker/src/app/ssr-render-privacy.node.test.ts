import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createPrivacyHandler } from '#app/handlers/privacy.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function flatten(text: string) {
	return text.replace(/\s+/g, ' ')
}

test('privacy page and usage doc distinguish chat-model inference from embeddings', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = {
		COOKIE_SECRET: testCookieSecret,
		SECRET_KMS: testSecretKms,
		...testOidcSigningEnv,
		APP_DB: store.db,
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env

	const response = await createPrivacyHandler(env).handler({
		request: new Request('https://example.com/privacy'),
	} as never)

	expect(response.status).toBe(200)
	const html = flatten(await response.text())
	expect(html).toContain('<title>Privacy</title>')
	expect(html).toContain('does not run its own chat-model agent loop')
	expect(html).toContain('does not bill for chat tokens')
	expect(html).toContain('Cloudflare Workers AI')
	expect(html).toContain(
		'Durable Object duration attribution: until account deletion',
	)
})
