import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import {
	countConnectionsForPlatformApp,
	deletePlatformOauthApp,
	getPlatformOauthAppBySlug,
	getPlatformOauthAppClientSecret,
	listPlatformOauthApps,
	listTopPlatformAppsByUse,
	PlatformOauthAppValidationError,
	renamePlatformOauthApp,
	upsertPlatformOauthApp,
} from './platform-apps.ts'

/** Platform OAuth apps are written by the operator (`kody_admin`). */
async function createHarness() {
	const database = await createTestDb()
	const db = createPgDatabase({
		connection: database.pg,
		role: 'kody_admin',
	}) as unknown as SqlDatabase
	const env = {
		SECRET_KMS: testSecretKms,
	} as Pick<Env, 'SECRET_KMS'>
	return {
		db,
		env,
		q: pgQuery(database.pg),
		[Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
	}
}

const baseGithubApp = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential' as const,
	allowedScopes: ['repo', 'read:user', 'gist'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com', 'github.com'],
}

test('upsert lifecycle encrypts secrets, omits retain fields, null clears, and partial disable preserves data', async () => {
	await using harness = await createHarness()
	const { db, env, q } = harness
	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			description: 'Send-only Gmail, no inbox.',
		},
	})

	const row = (await q.get(
		'SELECT client_secret_encrypted FROM platform_oauth_apps WHERE slug = ?',
		'github',
	)) as { client_secret_encrypted: string }
	expect(row.client_secret_encrypted).toBeTruthy()
	expect(row.client_secret_encrypted).not.toContain(
		'platform-github-client-secret-value',
	)
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	const app = await getPlatformOauthAppBySlug({ db, slug: 'github' })
	expect(app).toMatchObject({
		slug: 'github',
		provider: 'github',
		hasClientSecret: true,
		enabled: true,
		description: 'Send-only Gmail, no inbox.',
	})
	expect(JSON.stringify(app)).not.toContain(
		'platform-github-client-secret-value',
	)
	expect(Object.keys(app ?? {})).not.toContain('client_secret_encrypted')

	const retained = await upsertPlatformOauthApp({ db, env, app: baseGithubApp })
	expect(retained.description).toBe('Send-only Gmail, no inbox.')
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			clientSecret: undefined,
			label: 'GitHub (built-in)',
		},
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			flow: 'pkce',
			clientSecret: null,
		},
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBeNull()

	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			clientSecret: 'platform-github-client-secret-value',
			description: 'Set again.',
		},
	})
	const clearedDescription = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: null },
	})
	expect(clearedDescription.description).toBeNull()

	const disabled = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: 'github',
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			enabled: false,
		},
	})
	expect(disabled).toMatchObject({
		enabled: false,
		allowedScopes: ['gist', 'read:user', 'repo'],
		defaultScopes: ['read:user'],
		requiredHosts: ['api.github.com', 'github.com'],
		apiBaseUrl: 'https://api.github.com',
	})
	expect(
		await getPlatformOauthAppClientSecret({ db, env, slug: 'github' }),
	).toBe('platform-github-client-secret-value')

	const clearedFields = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: 'github',
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			allowedScopes: [],
			defaultScopes: [],
			requiredHosts: [],
		},
	})
	expect(clearedFields.allowedScopes).toEqual([])
	expect(clearedFields.requiredHosts).toEqual([])
})

test('confidential flow requires a client secret only while enabled', async () => {
	await using harness = await createHarness()
	const { db, env } = harness
	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: { ...baseGithubApp, clientSecret: null },
		}),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)

	const staged = await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, clientSecret: null, enabled: false },
	})
	expect(staged.enabled).toBe(false)
	expect(staged.hasClientSecret).toBe(false)

	await expect(
		upsertPlatformOauthApp({
			db,
			env,
			app: {
				slug: baseGithubApp.slug,
				clientId: baseGithubApp.clientId,
				tokenUrl: baseGithubApp.tokenUrl,
				authorizeUrl: baseGithubApp.authorizeUrl,
				flow: 'confidential',
				enabled: true,
			},
		}),
	).rejects.toBeInstanceOf(PlatformOauthAppValidationError)

	const live = await upsertPlatformOauthApp({
		db,
		env,
		app: {
			slug: baseGithubApp.slug,
			clientId: baseGithubApp.clientId,
			tokenUrl: baseGithubApp.tokenUrl,
			authorizeUrl: baseGithubApp.authorizeUrl,
			flow: 'confidential',
			clientSecret: 'late-pasted-secret',
			enabled: true,
		},
	})
	expect(live.enabled).toBe(true)
	expect(live.hasClientSecret).toBe(true)
})

test('allowedScopes always contains defaultScopes and disabled apps hide from the default list', async () => {
	await using harness = await createHarness()
	const { db, env } = harness
	await upsertPlatformOauthApp({
		db,
		env,
		app: {
			...baseGithubApp,
			allowedScopes: ['repo'],
			defaultScopes: ['read:user'],
			enabled: false,
		},
	})

	const app = await getPlatformOauthAppBySlug({
		db,
		slug: 'github',
		includeDisabled: true,
	})
	expect(app?.allowedScopes).toEqual(['read:user', 'repo'])

	expect(await listPlatformOauthApps({ db })).toEqual([])
	expect(await getPlatformOauthAppBySlug({ db, slug: 'github' })).toBeNull()
	expect(
		await listPlatformOauthApps({ db, includeDisabled: true }),
	).toHaveLength(1)
})

test('deletePlatformOauthApp refuses while user connections reference the app', async () => {
	await using harness = await createHarness()
	const { db, env, q } = harness
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })
	await q.run(
		`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug
			) VALUES (?, ?, NULL, ?)`,
		'user-1',
		'github',
		'github',
	)

	expect(await countConnectionsForPlatformApp({ db, slug: 'github' })).toBe(1)
	await expect(deletePlatformOauthApp({ db, slug: 'github' })).rejects.toThrow(
		'still has 1 user connection',
	)

	await q.run('DELETE FROM user_integrations WHERE user_id = ?', 'user-1')
	expect(await deletePlatformOauthApp({ db, slug: 'github' })).toBe(true)
})

test('listTopPlatformAppsByUse orders enabled apps by connection count and hides disabled', async () => {
	await using harness = await createHarness()
	const { db, env, q } = harness
	for (const slug of ['github', 'google', 'notion', 'slack']) {
		await upsertPlatformOauthApp({
			db,
			env,
			app: {
				...baseGithubApp,
				slug,
				enabled: slug !== 'slack',
			},
		})
	}
	const insertConnection = (userId: string, slug: string) =>
		q.run(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug
			) VALUES (?, ?, NULL, ?)`,
			userId,
			slug,
			slug,
		)
	await insertConnection('user-1', 'google')
	await insertConnection('user-2', 'google')
	await insertConnection('user-1', 'notion')
	await insertConnection('user-1', 'slack')
	await insertConnection('user-2', 'slack')
	await insertConnection('user-3', 'slack')

	const top = await listTopPlatformAppsByUse({ db, limit: 3 })
	expect(top.map((app) => app.slug)).toEqual(['google', 'notion', 'github'])

	const topTwo = await listTopPlatformAppsByUse({ db, limit: 2 })
	expect(topTwo.map((app) => app.slug)).toEqual(['google', 'notion'])
})

test('renamePlatformOauthApp carries the secret and moves connections atomically', async () => {
	await using harness = await createHarness()
	const { db, env, q } = harness
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, description: 'Kody-hosted GitHub app.' },
	})
	await q.run(
		`UPDATE platform_oauth_apps SET logo_key = ?, logo_content_type = ?
			WHERE slug = ?`,
		'platform-logos/github/abc123.png',
		'image/png',
		'github',
	)
	await q.run(
		`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug
			) VALUES (?, ?, NULL, ?)`,
		'user-1',
		'github',
		'github',
	)

	const renamed = await renamePlatformOauthApp({
		db,
		env,
		slug: 'github',
		newSlug: 'github-platform',
	})
	expect(renamed).toMatchObject({
		slug: 'github-platform',
		provider: 'github',
		description: 'Kody-hosted GitHub app.',
		hasClientSecret: true,
		logoKey: 'platform-logos/github/abc123.png',
	})
	// The write-only encrypted secret decrypts under the new slug.
	expect(
		await getPlatformOauthAppClientSecret({
			db,
			env,
			slug: 'github-platform',
		}),
	).toBe('platform-github-client-secret-value')
	// The old slug is gone; the connection moved but kept its name.
	expect(
		await getPlatformOauthAppBySlug({
			db,
			slug: 'github',
			includeDisabled: true,
		}),
	).toBeNull()
	expect(
		await countConnectionsForPlatformApp({ db, slug: 'github-platform' }),
	).toBe(1)
	const movedConnection = (await q.get(
		`SELECT name, platform_app_slug FROM user_integrations
			WHERE user_id = ?`,
		'user-1',
	)) as { name: string; platform_app_slug: string }
	expect(movedConnection).toEqual({
		name: 'github',
		platform_app_slug: 'github-platform',
	})

	// Guards: missing source, same slug, and collisions all reject.
	await expect(
		renamePlatformOauthApp({ db, env, slug: 'missing', newSlug: 'other' }),
	).rejects.toThrow('was not found')
	await expect(
		renamePlatformOauthApp({
			db,
			env,
			slug: 'github-platform',
			newSlug: 'github-platform',
		}),
	).rejects.toThrow('matches the current slug')
	await upsertPlatformOauthApp({
		db,
		env,
		app: { ...baseGithubApp, slug: 'occupied' },
	})
	await expect(
		renamePlatformOauthApp({
			db,
			env,
			slug: 'github-platform',
			newSlug: 'occupied',
		}),
	).rejects.toThrow('already exists')
})

test('user_integrations enforces exactly one of app_slug / platform_app_slug', async () => {
	await using harness = await createHarness()
	const { db, env, q } = harness
	await upsertPlatformOauthApp({ db, env, app: baseGithubApp })

	await expect(
		q.run(
			`INSERT INTO user_integrations (
					user_id, name, app_slug, platform_app_slug
				) VALUES (?, ?, ?, ?)`,
			'user-1',
			'github',
			'github',
			'github',
		),
	).rejects.toThrow(/check constraint/i)

	await expect(
		q.run(
			`INSERT INTO user_integrations (
					user_id, name, app_slug, platform_app_slug
				) VALUES (?, ?, NULL, NULL)`,
			'user-1',
			'github',
		),
	).rejects.toThrow(/check constraint/i)
})
