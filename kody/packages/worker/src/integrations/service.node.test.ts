import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'
import * as service from './service.ts'

type TestEnv = Pick<Env, 'APP_DB' | 'SECRET_KMS'>

/**
 * Every account gets its own RLS-scoped writer: the service calls below run
 * with `envFor(input.userId)`, and platform apps are written as `kody_admin`.
 */
let database: Awaited<ReturnType<typeof createTestDb>>
function envFor(userId: string): TestEnv {
	return {
		APP_DB: database.forUser(userId).db,
		SECRET_KMS: testSecretKms,
	} as unknown as TestEnv
}
function asUser<I extends { env: TestEnv; userId: string }, R>(
	fn: (input: I) => R,
) {
	return (input: Omit<I, 'env'> & { env?: unknown }) =>
		fn({ ...input, env: envFor(input.userId) } as unknown as I)
}
const deleteIntegration = asUser(service.deleteIntegration)
const deleteOauthAppIfUnused = asUser(service.deleteOauthAppIfUnused)
const deleteOauthAppWithConnections = asUser(
	service.deleteOauthAppWithConnections,
)
const findOauthAppForProviderSetup = asUser(
	service.findOauthAppForProviderSetup,
)
const getAvailablePlatformApp = asUser(service.getAvailablePlatformApp)
const getIntegration = asUser(service.getIntegration)
const getOauthApp = asUser(service.getOauthApp)
const listAvailablePlatformApps = asUser(service.listAvailablePlatformApps)
const listIntegrations = asUser(service.listIntegrations)
const listOauthApps = asUser(service.listOauthApps)
const listJoinedIntegrations = asUser(service.listJoinedIntegrations)
const rotateOauthAppClientCredentials = asUser(
	service.rotateOauthAppClientCredentials,
)
const upsertIntegration = asUser(service.upsertIntegration)
const upsertOauthAppWithoutConnection = asUser(
	service.upsertOauthAppWithoutConnection,
)
const upsertPlatformIntegration = asUser(service.upsertPlatformIntegration)

async function createEnv() {
	database = await createTestDb()
	return {
		env: { SECRET_KMS: testSecretKms } as unknown as TestEnv,
		admin: createPgDatabase({
			connection: database.pg,
			role: 'kody_admin',
		}) as unknown as SqlDatabase,
		q: pgQuery(database.pg),
		[Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
	}
}

const baseGoogleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('upsertIntegration reuses matching app tuples, splits on endpoint mismatch, and normalizes required hosts', async () => {
	await using harness = await createEnv()
	const { env } = harness
	const reuseUserId = 'user-upsert'

	const normalized = await upsertIntegration({
		env,
		userId: reuseUserId,
		config: {
			...baseGoogleConfig,
			requiredHosts: [
				'https://www.googleapis.com',
				'HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2',
				'oauth2.googleapis.com',
			],
		},
	})
	expect(normalized.requiredHosts).toEqual([
		'accounts.google.com',
		'oauth2.googleapis.com',
		'www.googleapis.com',
	])

	await upsertIntegration({
		env,
		userId: reuseUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-calendar',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['calendar.readonly'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
	})

	const apps = await listOauthApps({ env, userId: reuseUserId })
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
	})

	const listed = await listIntegrations({ env, userId: reuseUserId })
	expect(listed.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])
	expect(
		listed.every((entry) => entry.clientId === 'google-client-id-value'),
	).toBe(true)

	const splitUserId = 'user-upsert-split'
	await upsertIntegration({
		env,
		userId: splitUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: splitUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-legacy',
			tokenUrl: 'https://oauth2.googleapis.com/token/legacy',
		},
	})

	const splitApps = await listOauthApps({ env, userId: splitUserId })
	expect(splitApps).toHaveLength(2)
	expect(splitApps.map((app) => app.slug).sort()).toEqual([
		'google',
		'google-legacy',
	])
	expect(splitApps.find((app) => app.slug === 'google')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token',
	)
	expect(splitApps.find((app) => app.slug === 'google-legacy')?.tokenUrl).toBe(
		'https://oauth2.googleapis.com/token/legacy',
	)

	const google = await getIntegration({
		env,
		userId: splitUserId,
		name: 'google',
	})
	const legacy = await getIntegration({
		env,
		userId: splitUserId,
		name: 'google-legacy',
	})
	expect(google?.tokenUrl).toBe('https://oauth2.googleapis.com/token')
	expect(legacy?.tokenUrl).toBe('https://oauth2.googleapis.com/token/legacy')
})

test('rotateOauthAppClientCredentials updates sibling joins, blocks delete while connected, and canonicalizes slugs', async () => {
	await using harness = await createEnv()
	const { env } = harness
	const userId = 'user-rotate'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			...baseGoogleConfig,
			name: 'google-mail',
		},
	})

	const found = await getOauthApp({ env, userId, slug: 'Google' })
	expect(found).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-value',
	})

	const rotated = await rotateOauthAppClientCredentials({
		env,
		userId,
		slug: ' Google ',
		clientId: 'google-client-id-rotated',
	})
	expect(rotated).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		hasClientSecret: false,
	})

	const google = await getIntegration({ env, userId, name: 'google' })
	const googleMail = await getIntegration({ env, userId, name: 'google-mail' })
	expect(google?.clientId).toBe('google-client-id-rotated')
	expect(googleMail?.clientId).toBe('google-client-id-rotated')

	await expect(
		deleteOauthAppIfUnused({ env, userId, slug: 'GOOGLE' }),
	).rejects.toThrow(/still has 2 connections/)

	const stillThere = await getIntegration({ env, userId, name: 'google' })
	expect(stillThere?.name).toBe('google')

	expect(
		await deleteOauthAppWithConnections({
			env,
			userId,
			slug: 'GOOGLE',
		}),
	).toEqual({
		deleted: true,
		connectionNames: ['google', 'google-mail'],
	})
	expect(await listIntegrations({ env, userId })).toEqual([])
	expect(await getOauthApp({ env, userId, slug: 'google' })).toBeNull()
	expect(
		await deleteOauthAppWithConnections({
			env,
			userId,
			slug: 'google',
		}),
	).toEqual({ deleted: false, connectionNames: [] })
})

test('upsertIntegration reuses a confidential app that stored usePkce false as NULL', async () => {
	await using harness = await createEnv()
	const { env, q } = harness
	const now = '2026-02-01T00:00:00.000Z'
	await q.run(
		`INSERT INTO user_oauth_apps (
				user_id, slug, provider, label, client_id,
				token_url, authorize_url, api_base_url, flow, use_pkce,
				token_exchange_style, scope_separator, extra_authorize_params_json,
				created_at, updated_at
			) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'confidential', NULL, ?, NULL, '{}', ?, ?)`,
		'user-reuse',
		'canva',
		'canva',
		'canva-client-id-value',
		'https://api.canva.com/rest/v1/oauth/token',
		'https://api.canva.com',
		'basic-form',
		now,
		now,
	)
	await q.run(
		`INSERT INTO user_integrations (
				user_id, name, app_slug, account_label, description, scopes_json,
				required_hosts_json,
				connected_at, token_refreshed_at, created_at, updated_at
			) VALUES (?, ?, ?, NULL, '', '[]', ?, NULL, NULL, ?, ?)`,
		'user-reuse',
		'canva',
		'canva',
		JSON.stringify(['api.canva.com']),
		now,
		now,
	)

	const stored = (await q.get(
		`SELECT slug, flow, use_pkce FROM user_oauth_apps WHERE user_id = ?`,
		'user-reuse',
	)) as {
		slug: string
		flow: string
		use_pkce: number | null
	}
	expect(stored).toEqual({
		slug: 'canva',
		flow: 'confidential',
		use_pkce: null,
	})

	await upsertIntegration({
		env,
		userId: 'user-reuse',
		config: {
			name: 'canva-team',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com',
			flow: 'confidential',
			usePkce: false,
			clientId: 'canva-client-id-value',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
		},
	})

	const apps = await listOauthApps({ env, userId: 'user-reuse' })
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'canva',
		connectionCount: 2,
		usePkce: null,
		flow: 'confidential',
	})
	const joined = await listJoinedIntegrations({ env, userId: 'user-reuse' })
	expect(joined.map(({ connection }) => connection.name).sort()).toEqual([
		'canva',
		'canva-team',
	])
	expect(joined.every(({ app }) => app.slug === 'canva')).toBe(true)
})

test('shared app identity survives reuse and scope-only resaves across sibling connections', async () => {
	await using harness = await createEnv()
	const { env, q } = harness

	const preserveUserId = 'user-provider-preserve'
	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-calendar',
		},
	})
	const before = (await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		preserveUserId,
	)) as {
		slug: string
		provider: string
		label: string | null
		client_id: string
		token_url: string
		created_at: string
		updated_at: string
	}
	expect(before.provider).toBe('google')

	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: {
			...baseGoogleConfig,
			name: 'acme-thing',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['acme.scope'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
	})
	const afterReuse = (await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		preserveUserId,
	)) as typeof before
	expect(afterReuse).toEqual(before)

	const resaveUserId = 'user-four-shared'
	const names = [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const
	for (const name of names) {
		await upsertIntegration({
			env,
			userId: resaveUserId,
			config: {
				...baseGoogleConfig,
				name,
				authorization: {
					...baseGoogleConfig.authorization,
					scopes: [`${name}.initial`],
				},
				requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
			},
		})
	}
	const beforeResave = await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		resaveUserId,
	)

	await upsertIntegration({
		env,
		userId: resaveUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-mail',
			authorization: {
				...baseGoogleConfig.authorization,
				scopes: ['gmail.modify', 'gmail.readonly'],
			},
			requiredHosts: ['gmail.googleapis.com'],
		},
	})
	const afterResave = await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps WHERE user_id = ?`,
		resaveUserId,
	)
	expect(afterResave).toEqual(beforeResave)

	const connections = (await q.all(
		`SELECT name, app_slug, scopes_json, required_hosts_json
			FROM user_integrations WHERE user_id = ? ORDER BY name`,
		resaveUserId,
	)) as Array<{
		name: string
		app_slug: string
		scopes_json: string
		required_hosts_json: string
	}>
	expect(connections).toHaveLength(4)
	expect(connections.every((row) => row.app_slug === 'google')).toBe(true)
	expect(connections.find((row) => row.name === 'google-mail')).toMatchObject({
		scopes_json: JSON.stringify(['gmail.modify', 'gmail.readonly']),
		required_hosts_json: JSON.stringify(['gmail.googleapis.com']),
	})
})

test('rematch deletes orphan apps, keeps sibling apps intact, and converts sole user apps to platform', async () => {
	await using harness = await createEnv()
	const { env, q } = harness
	const orphanUserId = 'user-orphan'

	await upsertIntegration({
		env,
		userId: orphanUserId,
		config: baseGoogleConfig,
	})
	await upsertIntegration({
		env,
		userId: orphanUserId,
		config: {
			...baseGoogleConfig,
			name: 'solo-app',
			clientId: 'solo-client-id',
		},
	})
	expect(
		await q.all(
			`SELECT slug FROM user_oauth_apps WHERE user_id = ? ORDER BY slug`,
			orphanUserId,
		),
	).toEqual([{ slug: 'google' }, { slug: 'solo-app' }])

	await upsertIntegration({
		env,
		userId: orphanUserId,
		config: {
			...baseGoogleConfig,
			name: 'solo-app',
		},
	})

	expect(
		await q.all(
			`SELECT slug FROM user_oauth_apps WHERE user_id = ? ORDER BY slug`,
			orphanUserId,
		),
	).toEqual([{ slug: 'google' }])
	expect(
		await q.all(
			`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? ORDER BY name`,
			orphanUserId,
		),
	).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'solo-app', app_slug: 'google' },
	])

	const siblingUserId = 'user-sibling-keep'
	for (const name of [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const) {
		await upsertIntegration({
			env,
			userId: siblingUserId,
			config: {
				...baseGoogleConfig,
				name,
				authorization: {
					...baseGoogleConfig.authorization,
					scopes: name === 'google' ? ['openid', 'email'] : [`${name}.scope`],
				},
			},
		})
	}

	expect(
		(
			(await q.get(
				`SELECT count(*) AS count FROM user_integrations
					WHERE user_id = ? AND app_slug = 'google'`,
				siblingUserId,
			)) as { count: number }
		).count,
	).toBe(4)

	await upsertIntegration({
		env,
		userId: siblingUserId,
		config: {
			...baseGoogleConfig,
			name: 'google-drive',
			tokenUrl: 'https://oauth2.googleapis.com/token/other',
		},
	})

	const googleApp = (await q.get(
		`SELECT slug, provider FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		siblingUserId,
	)) as { slug: string; provider: string }
	expect(googleApp).toEqual({ slug: 'google', provider: 'google' })
	expect(
		(
			(await q.get(
				`SELECT count(*) AS count FROM user_integrations
					WHERE user_id = ? AND app_slug = 'google'`,
				siblingUserId,
			)) as { count: number }
		).count,
	).toBe(3)
	expect(
		await q.get(
			`SELECT name, app_slug FROM user_integrations
				WHERE user_id = ? AND name = 'google-drive'`,
			siblingUserId,
		),
	).toEqual({ name: 'google-drive', app_slug: 'google-drive' })

	const platformEnv = harness
	await provisionGithubPlatformApp(harness)
	const convertUserId = 'user-converts'

	await upsertIntegration({
		env: platformEnv.env,
		userId: convertUserId,
		config: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientId: 'personal-github-client-id',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})
	expect(
		await listOauthApps({ env: platformEnv.env, userId: convertUserId }),
	).toHaveLength(1)

	await upsertPlatformIntegration({
		env: platformEnv.env,
		userId: convertUserId,
		platformAppSlug: 'github',
		scopes: ['read:user'],
	})
	expect(
		await listOauthApps({ env: platformEnv.env, userId: convertUserId }),
	).toHaveLength(0)
	const joined = await listJoinedIntegrations({
		env: platformEnv.env,
		userId: convertUserId,
	})
	expect(joined).toHaveLength(1)
	expect(joined[0]?.lane).toBe('platform')
})

test('upsertOauthAppWithoutConnection covers setup, client-id reuse, and connected-app preservation', async () => {
	await using harness = await createEnv()
	const { env, q } = harness
	const setupUserId = 'user-setup-then-connect'

	const app = await upsertOauthAppWithoutConnection({
		env,
		userId: setupUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			usePkce: true,
			clientId: 'spotify-client-from-setup',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(app).toMatchObject({
		slug: 'spotify',
		clientId: 'spotify-client-from-setup',
		flow: 'pkce',
	})
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({
			slug: 'spotify',
			connectionCount: 0,
			clientId: 'spotify-client-from-setup',
		}),
	])
	expect(await listIntegrations({ env, userId: setupUserId })).toEqual([])

	await upsertIntegration({
		env,
		userId: setupUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientId: 'spotify-client-from-setup',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({
			slug: 'spotify',
			connectionCount: 1,
			clientId: 'spotify-client-from-setup',
		}),
	])

	const notionUserId = 'user-setup-orphan-reuse'
	await upsertOauthAppWithoutConnection({
		env,
		userId: notionUserId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-old',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	const updated = await upsertOauthAppWithoutConnection({
		env,
		userId: notionUserId,
		config: {
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			clientId: 'notion-client-new',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			},
		},
	})
	expect(updated).toMatchObject({
		slug: 'notion',
		clientId: 'notion-client-new',
	})
	expect(await listOauthApps({ env, userId: notionUserId })).toHaveLength(1)

	const preserveUserId = 'user-setup-preserve'
	await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	await upsertIntegration({
		env,
		userId: preserveUserId,
		config: {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['openid', 'email'],
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	const before = (await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		preserveUserId,
	)) as {
		slug: string
		provider: string
		label: string | null
		client_id: string
		token_url: string
		created_at: string
		updated_at: string
	}
	const secondSetup = await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
	})
	expect(secondSetup.slug).toBe('google')
	const after = (await q.get(
		`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = 'google'`,
		preserveUserId,
	)) as typeof before
	expect(after).toEqual(before)
})

test('findOauthAppForProviderSetup prefers an exact-slug setup app over family prefill', async () => {
	await using harness = await createEnv()
	const { env } = harness
	const userId = 'user-family-prefill'

	await upsertIntegration({
		env,
		userId,
		config: baseGoogleConfig,
	})
	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'calendar-only-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			},
		},
	})
	expect(
		await findOauthAppForProviderSetup({
			env,
			userId,
			name: 'google-calendar',
		}),
	).toMatchObject({
		slug: 'google-calendar',
		clientId: 'calendar-only-client',
		tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
	})
})

const createPlatformEnv = createEnv

async function provisionGithubPlatformApp(
	harness: Awaited<ReturnType<typeof createEnv>>,
) {
	return upsertPlatformOauthApp({
		db: harness.admin,
		env: harness.env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			allowedScopes: ['repo', 'read:user', 'gist'],
			defaultScopes: ['read:user'],
			requiredHosts: ['api.github.com'],
		},
	})
}

test('upsertPlatformIntegration enforces connect policy, hides secrets, and deletes without orphaning the shared app', async () => {
	await using harness = await createPlatformEnv()
	const { env } = harness
	await provisionGithubPlatformApp(harness)

	const saved = await upsertPlatformIntegration({
		env,
		userId: 'user-platform',
		platformAppSlug: 'github',
		scopes: ['read:user', 'repo'],
	})
	expect(saved).toMatchObject({
		name: 'github',
		platform: true,
		clientId: 'platform-github-client-id',
	})
	expect(saved.requiredHosts).toEqual(['api.github.com', 'github.com'])
	expect(saved.authorization?.scopes).toEqual(['read:user', 'repo'])

	const listed = await listIntegrations({ env, userId: 'user-platform' })
	expect(listed).toHaveLength(1)
	expect(listed[0]?.platform).toBe(true)
	expect(JSON.stringify(listed)).not.toContain(
		'platform-github-client-secret-value',
	)

	const joined = await listJoinedIntegrations({
		env,
		userId: 'user-platform',
	})
	expect(joined[0]?.lane).toBe('platform')
	expect(joined[0]?.connection.platformAppSlug).toBe('github')
	expect(joined[0]?.connection.appSlug).toBeNull()

	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-platform-scopes',
			platformAppSlug: 'github',
			scopes: ['admin:org'],
		}),
	).rejects.toThrow('Scopes not allowed for platform integration "github"')

	const defaultScopes = await upsertPlatformIntegration({
		env,
		userId: 'user-platform-defaults',
		platformAppSlug: 'github',
		scopes: [],
	})
	expect(defaultScopes.authorization?.scopes).toEqual(['read:user'])

	await upsertPlatformOauthApp({
		db: harness.admin,
		env,
		app: {
			slug: 'github-strict',
			clientId: 'platform-github-strict-id',
			clientSecret: 'platform-github-strict-secret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			allowedScopes: [],
			defaultScopes: [],
		},
	})
	await expect(
		upsertPlatformIntegration({
			env,
			userId: 'user-strict',
			platformAppSlug: 'github-strict',
			scopes: ['repo'],
		}),
	).rejects.toThrow(
		'Scopes not allowed for platform integration "github-strict"',
	)
	const scopeless = await upsertPlatformIntegration({
		env,
		userId: 'user-strict',
		platformAppSlug: 'github-strict',
		scopes: [],
	})
	expect(scopeless.authorization?.scopes).toEqual([])

	await upsertPlatformIntegration({
		env,
		userId: 'user-deletes',
		platformAppSlug: 'github',
		scopes: [],
	})
	expect(
		await deleteIntegration({ env, userId: 'user-deletes', name: 'github' }),
	).toBe(true)
	expect(await listIntegrations({ env, userId: 'user-deletes' })).toEqual([])
	expect(await getAvailablePlatformApp({ env, slug: 'github' })).not.toBeNull()

	const disabledEnv = harness
	const disabledApp = await provisionGithubPlatformApp(harness)
	await upsertPlatformOauthApp({
		db: harness.admin,
		env: disabledEnv.env,
		app: {
			slug: disabledApp.slug,
			clientId: disabledApp.clientId,
			tokenUrl: disabledApp.tokenUrl,
			authorizeUrl: disabledApp.authorizeUrl,
			flow: disabledApp.flow,
			enabled: false,
		},
	})

	expect(
		(await listAvailablePlatformApps({ env: disabledEnv.env })).map(
			(app) => app.slug,
		),
	).not.toContain('github')
	await expect(
		upsertPlatformIntegration({
			env: disabledEnv.env,
			userId: 'user-blocked',
			platformAppSlug: 'github',
			scopes: [],
		}),
	).rejects.toThrow('Platform integration "github" is not available.')
})

test('loading a platform integration adds current app hosts without removing connection hosts', async () => {
	await using harness = await createPlatformEnv()
	const { env, q } = harness
	const app = await provisionGithubPlatformApp(harness)
	await upsertPlatformIntegration({
		env,
		userId: 'user-stale-platform-hosts',
		platformAppSlug: app.slug,
		scopes: [],
	})
	await q.run(
		`UPDATE user_integrations
			SET required_hosts_json = ?
			WHERE user_id = ? AND name = ?`,
		JSON.stringify(['api.github.com', 'user-added.example.com']),
		'user-stale-platform-hosts',
		'github',
	)
	await upsertPlatformOauthApp({
		db: harness.admin,
		env,
		app: {
			slug: app.slug,
			clientId: app.clientId,
			tokenUrl: app.tokenUrl,
			authorizeUrl: app.authorizeUrl,
			apiBaseUrl: app.apiBaseUrl,
			flow: app.flow,
			requiredHosts: ['api.github.com', 'uploads.github.com'],
		},
	})

	const loaded = await getIntegration({
		env,
		userId: 'user-stale-platform-hosts',
		name: 'github',
	})

	expect(loaded?.requiredHosts).toEqual([
		'api.github.com',
		'uploads.github.com',
		'user-added.example.com',
	])
	expect(
		JSON.parse(
			(
				(await q.get(
					`SELECT required_hosts_json
						FROM user_integrations
						WHERE user_id = ? AND name = ?`,
					'user-stale-platform-hosts',
					'github',
				)) as {
					required_hosts_json: string
				}
			).required_hosts_json,
		),
	).toEqual(['api.github.com', 'uploads.github.com', 'user-added.example.com'])
})
