import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createBlogPostHandler } from '#app/handlers/blog.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { getBlogPost, getReadNextBlogPost } from '#worker/blog/catalog.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import { landingTestimonialsStorySlug } from '#universal/landing-testimonials.ts'

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

test('homepage carousel SSR keeps short quotes and story links only for vignettes', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const response = await renderAppPage({
		request: new Request('https://example.com/'),
		env: createTestEnv(store.db),
		loaderData: {},
	})
	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html.match(/class="landing-testimonial-story"/g)).toHaveLength(3)
	expect(html).toContain('href="/blog/early-kody-users#josh-tomaino"')
	expect(html).toContain('href="/blog/early-kody-users#jett-hays"')
	expect(html).toContain('href="/blog/early-kody-users#gabriel-alegria"')
	expect(html).toContain('Gabriel Alegría')
	expect(html).toContain('src="/images/testimonials/gabriel-alegria.webp"')
	expect(html).toContain(
		'href="https://www.linkedin.com/in/gabriel-alegria-mx"',
	)
	expect(html).toContain('Erik Rasmussen')
	expect(html).toContain('src="/images/testimonials/erik-rasmussen.webp"')
	expect(html).toContain(
		'href="https://x.com/erikras/status/2097720067316203941"',
	)
	expect(html).not.toContain('landing-testimonial-initials')
})

test('early-users blog post SSR renders approved vignettes and heading anchors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const post = getBlogPost(landingTestimonialsStorySlug)
	expect(post).toBeDefined()
	const env = createTestEnv(store.db)
	const response = await createBlogPostHandler(env).handler({
		request: new Request(
			`https://example.com/blog/${landingTestimonialsStorySlug}`,
		),
		params: { slug: landingTestimonialsStorySlug },
	} as never)
	expect(response.status).toBe(200)
	const html = await response.text()

	expect(html).toContain('id="josh-tomaino"')
	expect(html).toContain('id="jett-hays"')
	expect(html).toContain('id="gabriel-alegria"')
	expect(html).toContain('Gabriel Alegría')
	expect(getReadNextBlogPost(landingTestimonialsStorySlug)).not.toBeNull()
})
