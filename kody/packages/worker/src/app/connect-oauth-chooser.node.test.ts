import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test } from 'vitest'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	upsertIntegration,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import { loadConnectOauthChooser } from './connect-oauth-chooser.ts'

async function createEnv(userId = 'user-chooser') {
	const sqlite = await createTestPg()

	return {
		operatorDb: createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
		APP_DB: createPgDatabase({
			connection: sqlite,
			role: 'kody_writer',
			userId,
		}),
	} as Env & { operatorDb: ReturnType<typeof createPgDatabase> }
}

test('connect chooser includes saved connections and hides unused built-ins', async () => {
	const env = await createEnv()
	const platformEnv = {
		...env,
		SECRET_KMS: testSecretKms,
	} as Env
	await upsertPlatformOauthApp({
		db: env.operatorDb,
		env: platformEnv,
		app: {
			slug: 'google',
			label: 'Google',
			clientId: 'platform-google-client',
			clientSecret: 'platform-google-secret',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			flow: 'confidential',
			defaultScopes: ['openid'],
			allowedScopes: ['openid', 'email'],
		},
	})
	await upsertPlatformOauthApp({
		db: env.operatorDb,
		env: platformEnv,
		app: {
			slug: 'github',
			label: 'GitHub',
			clientId: 'platform-github-client',
			clientSecret: 'platform-github-secret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			defaultScopes: ['read:user'],
		},
	})
	await upsertPlatformIntegration({
		env,
		userId: 'user-chooser',
		platformAppSlug: 'github',
		name: 'github',
		scopes: ['read:user'],
	})
	await upsertIntegration({
		env,
		userId: 'user-chooser',
		config: {
			name: 'spotify-home',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			clientId: 'spotify-client',
			requiredHosts: ['accounts.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})

	const chooser = await loadConnectOauthChooser({
		env,
		userId: 'user-chooser',
	})
	expect(chooser.options.map((option) => option.id)).toEqual([
		'connection:github',
		'connection:spotify-home',
	])
	expect(
		chooser.options.find((option) => option.id === 'connection:spotify-home'),
	).toMatchObject({
		href: '/connect/oauth?provider=spotify-home&app=spotify-home',
		kind: 'connection',
		detail: 'Reconnect your OAuth app',
	})
	expect(
		chooser.options.find((option) => option.id === 'connection:github'),
	).toMatchObject({
		href: '/connect/oauth?provider=github',
		kind: 'connection',
		detail: 'Set up your own OAuth app to reconnect',
	})
})
