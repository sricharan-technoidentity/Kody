import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import {
	createInternalErrorPageHandler,
	createNotFoundPageHandler,
} from '#app/handlers/error-pages.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
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

function readAppRootProps(html: string) {
	const match = html.match(
		/<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/,
	)
	if (!match?.[1]) {
		throw new Error('rmx-data script not found in HTML response')
	}
	const rmxData = JSON.parse(match[1]) as {
		h: Record<string, { props: Record<string, unknown> }>
	}
	const entry = Object.values(rmxData.h)[0]
	if (!entry) {
		throw new Error('AppRoot hydration entry not found in rmx-data')
	}
	return entry.props
}

test('GET /404 and /500 are explicit illustrated error routes', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = createTestEnv(store.db)

	const notFoundResponse = await createNotFoundPageHandler(env).handler({
		request: new Request('https://example.com/404'),
	} as never)
	expect(notFoundResponse.status).toBe(404)
	const notFoundHtml = await notFoundResponse.text()
	expect(notFoundHtml).toContain('<title>Not found</title>')
	expect(notFoundHtml).toContain("This doesn't quite connect.")
	expect(notFoundHtml).toContain('src="/images/kody-404-disappointed.png"')
	expect(notFoundHtml).toContain('data-testid="not-found-page"')
	expect(readAppRootProps(notFoundHtml).notFound).toBe(true)

	const internalErrorResponse = await createInternalErrorPageHandler(
		env,
	).handler({
		request: new Request('https://example.com/500'),
	} as never)
	expect(internalErrorResponse.status).toBe(500)
	const internalErrorHtml = await internalErrorResponse.text()
	expect(internalErrorHtml).toContain('<title>Something went wrong</title>')
	expect(internalErrorHtml).toContain('We got a little zapped.')
	expect(internalErrorHtml).toContain('src="/images/kody-500-zapped.png"')
	expect(internalErrorHtml).toContain('data-testid="internal-error-page"')
	expect(readAppRootProps(internalErrorHtml).internalError).toBe(true)
})
