import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { landingFactoryBeats } from '#universal/landing-factory-beats.ts'
import { landingHeroPrimaryCta } from '#universal/landing-home-copy.ts'
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

function landingHeroMarkup(html: string) {
	const match = html.match(
		/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/,
	)
	return match?.[0] ?? ''
}

const homepageHeroVideos = [
	{
		videoId: 'iGMkgjXc8Ho',
		title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
	},
	{
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	},
	{
		videoId: 'o5L5OprLhBg',
		title: 'Kody fixes a Stripe webhook after we renamed the domain',
	},
	{
		videoId: 'OZKDO9Pzmo0',
		title: 'Shade automation from an INTENT.md',
	},
] as const

function homepageOnboardingFixture(
	env: Env,
	requestUrl: string,
	loggedIn: boolean,
) {
	return loadHomePageOnboardingData({
		env,
		requestUrl,
		user: loggedIn ? { username: 'home-user', emailVerified: true } : null,
	})
}

test('homepage hero uses locked copy, compare, and session-aware connect CTA', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = createTestEnv(store.db)
	const requestUrl = 'https://example.com/'

	const anonymous = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, false),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	expect(anonymous.status).toBe(200)
	const anonymousHtml = await anonymous.text()
	const anonymousHero = landingHeroMarkup(anonymousHtml)
	expect(anonymousHero).toContain(landingHeroPrimaryCta)
	expect(anonymousHero).toContain('href="#primitives"')
	expect(anonymousHero).toContain('/signup?utm_source=kody.codes')
	expect(anonymousHero).not.toContain('landing-hero-video')
	expect(anonymousHero).not.toContain('landing-hero-agents')
	expect(anonymousHtml).toContain('id="primitives"')
	expect(anonymousHtml).toContain('href="/docs"')
	expect(anonymousHtml).toContain('landing-proof')
	expect(anonymousHtml).toContain('landing-hero-agents')
	expect(anonymousHtml).toContain('landing-videos')
	expect(anonymousHtml).toContain('role="listbox"')
	expect(anonymousHtml).toContain(
		`/youtube-thumb/${homepageHeroVideos[0].videoId}`,
	)
	expect(
		anonymousHtml.indexOf(`/youtube-thumb/${homepageHeroVideos[0].videoId}`),
	).toBeLessThan(
		anonymousHtml.indexOf(`/youtube-thumb/${homepageHeroVideos[1].videoId}`),
	)
	expect(anonymousHtml).not.toContain('data-embed-playlist')
	expect(anonymousHtml).toContain('landing-hero-agent-light')
	expect(anonymousHtml).toContain('landing-hero-agent-track')
	expect(anonymousHtml).toContain('href="/docs/github"')
	expect(anonymousHtml).toContain('href="/docs/slack"')
	const inviteTools =
		anonymousHtml.match(
			/<ul[^>]*class="[^"]*landing-invite-tools[^"]*"[\s\S]*?<\/ul>/,
		)?.[0] ?? ''
	for (const label of [
		'GitHub',
		'Linear',
		'Sentry',
		'Cloudflare',
		'Slack',
		'Public packages',
	]) {
		expect(inviteTools).toContain(label)
	}
	for (const icon of ['github', 'linear', 'sentry', 'cloudflare', 'slack']) {
		expect(inviteTools).toContain(`/images/icons/${icon}.svg`)
	}
	expect(anonymousHtml).toContain('aria-label="Example triggers"')
	for (const beat of landingFactoryBeats) {
		expect(anonymousHtml).toContain(`href="/docs/${beat.slug}"`)
		expect(anonymousHtml).toContain(beat.trigger)
		expect(anonymousHtml).toContain(beat.title)
	}

	const signedIn = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, true),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	expect(signedIn.status).toBe(200)
	const signedInHtml = await signedIn.text()
	const signedInHero = landingHeroMarkup(signedInHtml)
	expect(signedInHero).toContain(landingHeroPrimaryCta)
	expect(signedInHero).toContain('href="/onboarding"')
	expect(signedInHero).not.toContain('/signup?utm_source=kody.codes')
	expect(signedInHtml).toContain('landing-videos')
	expect(signedInHtml).toContain('landing-hero-agents')
})

test('homepage ?og= points crawlers at that card and keeps the canonical url clean', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	const env = createTestEnv(store.db)
	const variantRequestUrl =
		'https://example.com/?og=triggers&utm_source=youtube#primitives'
	const variant = await renderAppPage({
		request: new Request(variantRequestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, variantRequestUrl, false),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	expect(variant.status).toBe(200)
	const variantHtml = await variant.text()
	const imageUrl = 'https://example.com/og/home.png?og=triggers'
	expect(variantHtml).toContain(`property="og:image" content="${imageUrl}"`)
	expect(variantHtml).toContain(`name="twitter:image" content="${imageUrl}"`)
	expect(variantHtml).toContain(
		'property="og:title" content="Invoke deterministic code from anything"',
	)
	expect(variantHtml).toContain('rel="canonical" href="https://example.com/"')
	expect(variantHtml).not.toContain('og:url" content="https://example.com/?og=')

	const unknown = await renderAppPage({
		request: new Request('https://example.com/?og=nope'),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(
				env,
				'https://example.com/?og=nope',
				false,
			),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	const unknownHtml = await unknown.text()
	expect(unknownHtml).toContain(
		'property="og:image" content="https://example.com/og/home.png"',
	)
	expect(unknownHtml).not.toContain('/og/home.png?og=')
})
