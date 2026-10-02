import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { loadSessionInfo } from '#app/session-info.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/account-profile-data.ts', () => ({
	loadAccountProfileData: vi.fn(async () => ({
		ok: true,
		email: 'account@example.com',
		emailVerified: false,
		username: 'account-user',
		displayName: 'account-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})),
}))

vi.mock('#app/account-connections-data.ts', () => ({
	loadAccountConnectionsData: vi.fn(async () => ({
		ok: true,
		connections: [],
		canDisconnect: false,
		hasUsablePassword: true,
		availableProviders: [],
		canSyncDiscordRoles: false,
	})),
}))

vi.mock('#app/onboarding-data.ts', () => ({
	loadOnboardingData: vi.fn(async () => ({
		ok: true,
		loggedIn: true,
		username: 'account-user',
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
	})),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(),
}))

type TestDb = Awaited<ReturnType<typeof createTestDb>>

function createEnv(db: PgDatabase) {
	return {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: db,
	} as unknown as Env
}

async function seedAccount(
	store: TestDb,
	input: { id: number; email: string; username: string; deletingAt?: string },
) {
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id, deleting_at)
		 VALUES ($1, $2, $3, 'unused', $4, $5)`,
		[
			input.id,
			input.email,
			input.username,
			testStableUserIdFromEmail(input.email),
			input.deletingAt ?? null,
		],
	)
}

/** Counts prepares and batch sizes on the scoped writer. */
function countQueries(db: PgDatabase) {
	const counts = { prepare: 0, batch: 0, batchSizes: [] as Array<number> }
	const counted: PgDatabase = {
		...db,
		prepare(sql: string) {
			counts.prepare += 1
			return db.prepare(sql)
		},
		batch(statements) {
			counts.batch += 1
			counts.batchSizes.push(statements.length)
			return db.batch(statements)
		},
	}
	return { db: counted, counts }
}

async function requestAccountPage(env: Env, cookie: string) {
	return await createAccountHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/account', {
				headers: { Cookie: cookie },
			}),
		),
	)
}

function loginRedirectState(response: Response) {
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	return {
		status: response.status,
		location: response.headers.get('Location'),
		clearsSession:
			setCookie.includes('kody_session=') && setCookie.includes('Max-Age=0'),
	}
}

const signedOutRedirect = {
	status: 302,
	location: 'https://example.com/login?redirectTo=%2Faccount',
	clearsSession: true,
}

test('account handler redirects to login with a session-destroy cookie for stale sessions', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'f'.repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	// A bystander exists, but no row matches the cookie's account.
	await seedAccount(store, {
		id: 1,
		email: 'bystander@example.com',
		username: 'bystander',
	})

	expect(
		loginRedirectState(
			await requestAccountPage(
				createEnv(store.forUser(session.stableUserId).db),
				cookie,
			),
		),
	).toEqual(signedOutRedirect)
})

test('account handler redirects to login and clears the cookie for a deleting account', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: testStableUserIdFromEmail('deleting@example.com'),
		email: 'deleting@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	await seedAccount(store, {
		id: 7,
		email: 'deleting@example.com',
		username: 'deleting-user',
		deletingAt: '2026-08-31 15:00:00',
	})

	expect(
		loginRedirectState(
			await requestAccountPage(
				createEnv(store.forUser(session.stableUserId).db),
				cookie,
			),
		),
	).toEqual(signedOutRedirect)
})

test('authenticated account SSR batches user/role and flag reads into two round trips', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'account@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const cookie = await createAuthCookie(
		{ stableUserId, email, rememberMe: false },
		false,
	)
	await using store = await createTestDb()
	await seedAccount(store, { id: 7, email, username: 'account-user' })
	await store.pg.exec(`
		INSERT INTO user_roles (user_id, role_id) SELECT 7, id FROM roles WHERE name = 'user';
		INSERT INTO feature_flags (key, enabled) VALUES ('demo-indicator', 1);
		INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled)
		VALUES ('compact-mcp-server-instructions', 7, 1);
	`)
	const { db, counts } = countQueries(store.forUser(stableUserId).db)

	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({
			session: loaded.session,
			loaderData: input.loaderData,
		})
	})

	const response = await requestAccountPage(createEnv(db), cookie)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		session: {
			username: string
			roles: Array<string>
			permissions: Array<string>
			featureFlags: Record<string, boolean>
		}
		loaderData: Record<string, unknown>
	}
	expect(body.session.username).toBe('account-user')
	expect(body.session.roles).toEqual(['user'])
	expect(body.session.permissions).toContain('read:user:own')
	expect(body.session.featureFlags).toEqual({
		'demo-indicator': true,
		'compact-mcp-server-instructions': true,
		'package-share-grants': false,
		'secret-providers': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
	})
	expect(Object.keys(body.loaderData).sort()).toEqual([
		'accountConnections',
		'accountProfile',
		'onboarding',
	])
	// Session batches: users+roles, then flags+overrides+experiments_opt_in.
	expect(counts.batchSizes).toEqual([2, 3])
	expect(counts.prepare).toBe(5)
	expect(counts.batch).toBe(2)
})
