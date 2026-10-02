import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createHomeHandler } from '#app/handlers/home.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { hasResolvedRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/onboarding-data.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/onboarding-data.ts')>()
	return {
		...actual,
		loadOnboardingData: vi.fn(actual.loadOnboardingData),
	}
})

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(),
}))

test('authenticated home SSR prefetches flags while loading page data', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'home@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const session: AuthSession = {
		stableUserId,
		email,
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id)
		 VALUES (7, $1, 'home-user', 'unused', $2)`,
		[email, stableUserId],
	)
	await store.pg.exec(`
		INSERT INTO user_roles (user_id, role_id) SELECT 7, id FROM roles WHERE name = 'user';
		INSERT INTO feature_flags (key, enabled) VALUES ('demo-indicator', 1);
		INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled)
		VALUES ('compact-mcp-server-instructions', 7, 1);
	`)
	const db = store.forUser(stableUserId).db
	const counts = { batchSizes: [] as Array<number> }
	const env = {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			...db,
			batch(statements) {
				counts.batchSizes.push(statements.length)
				return db.batch(statements)
			},
		} satisfies PgDatabase,
	} as unknown as Env

	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie },
	})
	vi.mocked(loadOnboardingData).mockImplementation(async () => {
		expect(hasResolvedRequestFeatureFlags(request)).toBe(true)
		expect(counts.batchSizes).toEqual([2, 3])
		return {
			ok: true,
			loggedIn: true,
			username: 'home-user',
			mcpServerUrl: 'https://example.com/mcp',
			setupPrompt: '',
			discoveryPrompt: '',
			persistPrompt: '',
			hasAccessWin: false,
			hasSecondMcpClient: false,
			hasMcpClient: false,
			connectedAgents: [],
			secondAgentStandardGift: {
				received: false,
				active: false,
				status: 'none',
				expiresAt: null,
				grantedAt: null,
			},
			emailVerified: false,
			needsOnboarding: true,
			featuredListings: [],
			featuredMcpServers: [],
			customMcpServers: [],
			persistedPackageName: null,
			accessWinMemorySubject: null,
			checklist: null,
		}
	})
	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({ session: loaded.session })
	})

	const response = await createHomeHandler(env).handler(
		new RequestContext(request),
	)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		session: { username: string; featureFlags: Record<string, boolean> }
	}
	expect(body.session.username).toBe('home-user')
	expect(body.session.featureFlags).toEqual({
		'demo-indicator': true,
		'compact-mcp-server-instructions': true,
		'package-share-grants': false,
		'secret-providers': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
	})
	expect(counts.batchSizes).toEqual([2, 3])
	expect(loadOnboardingData).not.toHaveBeenCalled()
	const homeInput = vi.mocked(renderAppPage).mock.calls.at(-1)?.[0]
	expect(homeInput?.listedBanners).toEqual(expect.any(Promise))
	expect(homeInput?.loaderData?.onboarding).toMatchObject({
		loggedIn: true,
		username: 'home-user',
		emailVerified: false,
		featuredMcpServers: [],
		setupPrompt: '',
		persistPrompt: '',
	})
	expect(
		homeInput?.loaderData?.onboarding?.discoveryPrompt.length,
	).toBeGreaterThan(0)
})

test('anonymous home SSR omits the unused onboarding chooser catalog', async () => {
	vi.mocked(renderAppPage).mockResolvedValue(new Response('ok'))

	setAuthSessionSecret(testCookieSecret)
	const response = await createHomeHandler({
		COOKIE_SECRET: testCookieSecret,
	} as Env).handler(new RequestContext(new Request('https://example.com/')))
	expect(response.status).toBe(200)
	const input = vi.mocked(renderAppPage).mock.calls.at(-1)?.[0]
	expect(input?.loaderData?.onboarding?.discoveryPrompt.length).toBeGreaterThan(
		0,
	)
	expect(input?.loaderData?.landingHeroVideos).toEqual([])
})
