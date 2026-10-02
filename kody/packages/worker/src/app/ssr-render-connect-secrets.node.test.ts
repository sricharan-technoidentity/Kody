import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const userStableId = testStableUserIdFromEmail('user@example.com')

async function createUserTestDb() {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id)
		 VALUES (1, 'user@example.com', 'account-user', 'unused', $1)`,
		[userStableId],
	)
	return store
}

test('renderAppPage server-renders the dedicated connect-secrets approval page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createUserTestDb()
	const env = {
		COOKIE_SECRET: testCookieSecret,
		SECRET_KMS: testSecretKms,
		...testOidcSigningEnv,
		APP_DB: store.forUser(userStableId).db,
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
	const cookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)

	const connectSecretsResponse = await renderAppPage({
		request: new Request(
			'https://example.com/connect/secrets?name=googleAccessToken&hosts=gmail.googleapis.com,oauth2.googleapis.com',
			{ headers: { Cookie: cookie } },
		),
		env,
		loaderData: {
			accountSecrets: {
				ok: true,
				email: 'user@example.com',
				packageOptions: [],
				packages: [],
				secrets: [
					{
						id: 'user:googleAccessToken',
						name: 'googleAccessToken',
						scope: 'user',
						description: '',
						packageId: null,
						packageTitle: null,
						allowedHosts: ['oauth2.googleapis.com'],
						allowedPackages: [],
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						expiresAt: null,
						ttlMs: null,
					},
				],
				selectedSecret: null,
				approval: {
					name: 'googleAccessToken',
					names: ['googleAccessToken'],
					scope: 'user',
					requestedHost: 'gmail.googleapis.com',
					requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
					rejectedHosts: [],
					requestedPackageId: null,
					currentAllowedHosts: ['oauth2.googleapis.com'],
					currentAllowedPackages: [],
				},
				approvalError: null,
			},
		},
	})
	expect(connectSecretsResponse.status).toBe(200)
	const connectSecretsHtml = await connectSecretsResponse.text()
	expect(connectSecretsHtml).toContain('data-testid="connect-secrets"')
	expect(connectSecretsHtml).toContain('gmail.googleapis.com')
	expect(connectSecretsHtml).toContain('oauth2.googleapis.com')
	expect(connectSecretsHtml).toContain('Allow all 2 hosts')
	expect(connectSecretsHtml).not.toContain('New secret')
})

test('renderAppPage flags invalid connect-secrets hosts instead of offering Allow all', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	await using store = await createUserTestDb()
	const env = {
		COOKIE_SECRET: testCookieSecret,
		SECRET_KMS: testSecretKms,
		...testOidcSigningEnv,
		APP_DB: store.forUser(userStableId).db,
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
	const cookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)

	const connectSecretsResponse = await renderAppPage({
		request: new Request(
			'https://example.com/connect/secrets?names=slackWebhookPath,openaiApiKey&hosts=hooks.slack.com,api.ope',
			{ headers: { Cookie: cookie } },
		),
		env,
		loaderData: {
			accountSecrets: {
				ok: true,
				email: 'user@example.com',
				packageOptions: [],
				packages: [],
				secrets: [
					{
						id: 'user:openaiApiKey',
						name: 'openaiApiKey',
						scope: 'user',
						description: '',
						packageId: null,
						packageTitle: null,
						allowedHosts: [],
						allowedPackages: [],
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						expiresAt: null,
						ttlMs: null,
					},
				],
				selectedSecret: null,
				approval: {
					name: 'openaiApiKey',
					names: ['openaiApiKey'],
					scope: 'user',
					requestedHost: 'hooks.slack.com',
					requestedHosts: ['hooks.slack.com'],
					rejectedHosts: [
						{
							host: 'api.ope',
							reason: 'unknown_suffix',
							message:
								"This host doesn't look complete (unknown public suffix). The approval link may have been truncated — copy it again.",
						},
					],
					requestedPackageId: null,
					currentAllowedHosts: [],
					currentAllowedPackages: [],
				},
				approvalError: null,
			},
		},
	})
	expect(connectSecretsResponse.status).toBe(200)
	const connectSecretsHtml = await connectSecretsResponse.text()
	expect(connectSecretsHtml).toContain('data-testid="connect-secrets"')
	expect(connectSecretsHtml).toContain('hooks.slack.com')
	expect(connectSecretsHtml).toContain('api.ope')
	expect(connectSecretsHtml).toContain(
		'data-testid="connect-secrets-rejected-hosts"',
	)
	expect(connectSecretsHtml).toContain('Allow access')
	expect(connectSecretsHtml).not.toContain('Allow all 2 hosts')
})
