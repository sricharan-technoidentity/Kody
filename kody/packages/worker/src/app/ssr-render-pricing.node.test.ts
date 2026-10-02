import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('renderAppPage renders the redesigned pricing page', async () => {
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

	const response = await renderAppPage({
		request: new Request('https://example.com/pricing'),
		env,
	})

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).not.toContain('Standard')
	expect(html).not.toMatch(/\bMax\b/)
	expect(html).toContain('Pro')
	expect(html).toContain('$12')
	expect(html).toContain(
		'More room for jobs, workflows, and daily volume, with a monthly include. Need more? Add prepaid credits.',
	)
	expect(html).toContain('Prepaid credits')
	// Customer story: Free hard-capped; Pro seat + include; credits until
	// gone; small print on how far credits go and the stop.
	expect(html).toContain(
		'Pro includes the usage in the table. Need more? Add prepaid credits and keep going until they run out. Free stops at its limits.',
	)
	expect(html).toContain(
		'Usage past the include is charged from credits (Worker compute and Rows read). Daily and weekly limits can go up to 50× Pro’s included limits on credits. When credits run out, usage past the include stops. No overage invoices.',
	)
	expect(html).toContain('Teams / Enterprise')
	expect(html).toContain('mailto:kody@kody.codes')
	expect(html).toContain('Durable Object rows read per month')
	expect(html).toContain('Execute calls per week')
	expect(html).toContain('Outbound fetches per week')
	expect(html).toContain('1,200')
	expect(html).toContain('Automation invocations per day')
	expect(html).toContain('1,000')
	expect(html).toContain('10,000')
	expect(html).toContain('15,000')
	expect(html).toContain('40,000')
	expect(html).not.toContain('120,000')
	expect(html).toMatch(/<a[^>]*href="\/docs\/kody-factory"[^>]*>factory<\/a>/)
})
