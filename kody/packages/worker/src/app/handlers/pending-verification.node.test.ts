import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createPendingVerificationHandler } from '#app/handlers/pending-verification.ts'
import { loadRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const pendingStableUserId = testStableUserIdFromEmail('pending@example.com')

/**
 * Runs the handler on the pending account's own writer. Page auth prefetches
 * flags without awaiting them (redirects never render), so settle that query
 * before the test database closes.
 */
async function requestPendingVerification(
	store: TestDb,
	url: string,
	cookie?: string,
) {
	const env = {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: store.forUser(pendingStableUserId).db,
	} as unknown as Env
	const request = new Request(url, {
		headers: cookie ? { Cookie: cookie } : {},
	})
	const response = await createPendingVerificationHandler(env).handler(
		new RequestContext(request),
	)
	if (cookie) {
		await loadRequestFeatureFlags(request, env, {
			userId: 1,
			stableUserId: pendingStableUserId,
		})
	}
	return response
}

test('pending verification requires a live session, preserves redirectTo after verify, and renders when unverified', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: pendingStableUserId,
		email: 'pending@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id)
		 VALUES (1, 'pending@example.com', 'pending-user', 'unused', $1)`,
		[pendingStableUserId],
	)
	const pageUrl = 'https://example.com/pending-verification'

	const anonymousResponse = await requestPendingVerification(store, pageUrl)
	expect(anonymousResponse.status).toBe(302)
	expect(anonymousResponse.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Fpending-verification',
	)

	const pendingResponse = await requestPendingVerification(
		store,
		pageUrl,
		cookie,
	)
	expect(pendingResponse.status).toBe(200)
	await expect(pendingResponse.json()).resolves.toEqual({
		ok: true,
		loaderData: {
			pendingVerification: {
				ok: true,
				email: 'pending@example.com',
				emailVerificationDelivery: null,
			},
		},
	})

	await store.pg.query(
		`UPDATE users SET email_verified_at = $1 WHERE stable_user_id = $2`,
		[new Date(0).toISOString(), pendingStableUserId],
	)
	const verifiedResponse = await requestPendingVerification(
		store,
		pageUrl,
		cookie,
	)
	expect(verifiedResponse.status).toBe(302)
	expect(verifiedResponse.headers.get('Location')).toBe(
		'https://example.com/onboarding',
	)

	const verifiedWithRedirect = await requestPendingVerification(
		store,
		`${pageUrl}?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Ddemo`,
		cookie,
	)
	expect(verifiedWithRedirect.status).toBe(302)
	expect(verifiedWithRedirect.headers.get('Location')).toBe(
		'https://example.com/oauth/authorize?client_id=demo',
	)

	const verifiedRejectsOpenRedirect = await requestPendingVerification(
		store,
		`${pageUrl}?redirectTo=https%3A%2F%2Fevil.example`,
		cookie,
	)
	expect(verifiedRejectsOpenRedirect.status).toBe(302)
	expect(verifiedRejectsOpenRedirect.headers.get('Location')).toBe(
		'https://example.com/onboarding',
	)
})
