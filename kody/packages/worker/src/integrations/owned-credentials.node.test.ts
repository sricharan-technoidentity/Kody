import { expect, test } from 'vitest'
import {
	listSecrets,
	listUserSecretsForSearch,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import {
	createUserTestEnv,
	pgQuery,
	seedSavedPackage,
} from '#worker/test-support/aws/user-test-env.ts'
import {
	persistIntegrationTokens,
	persistUserOauthAppClientSecret,
	resolveIntegrationAccessToken,
	resolveIntegrationRefreshToken,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import {
	assertCanUseIntegration,
	buildIntegrationPackageApprovalUrl,
	IntegrationPackageAccessDeniedError,
} from './package-access.ts'
import {
	deleteIntegration,
	deleteOauthAppWithConnections,
	grantIntegrationPackage,
	lockIntegrationToPackage,
	setIntegrationUsage,
	upsertIntegration,
} from './service.ts'

const storageContext = { sessionId: null, appId: null, packageId: null }

async function createHarness(userId: string) {
	const harness = await createUserTestEnv({ userId })
	return { ...harness, q: pgQuery(harness.pg) }
}

const googleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'confidential' as const,
	clientId: 'google-client-id',
	requiredHosts: ['www.googleapis.com', 'oauth2.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('integration-owned credentials persist as ciphertext, stay off secret lists, and survive sibling disconnect', async () => {
	const userId = 'user-owned-creds'
	await using harness = await createHarness(userId)
	const { env, q } = harness
	await seedSavedPackage(harness.pg, { id: 'pkg-mail', userId, kodyId: 'mail' })
	await seedSavedPackage(harness.pg, { id: 'pkg-docs', userId, kodyId: 'docs' })

	await upsertIntegration({ env, userId, config: googleConfig })
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})
	await persistUserOauthAppClientSecret({
		env,
		userId,
		slug: 'google',
		value: 'client-secret-live',
	})

	const ciphertexts = (await q.get(
		`SELECT access_token_encrypted, refresh_token_encrypted
			FROM user_integrations
			WHERE user_id = ? AND name = ?`,
		userId,
		'google',
	)) as {
		access_token_encrypted: string
		refresh_token_encrypted: string
	}
	expect(ciphertexts.access_token_encrypted).not.toContain('access-live')
	expect(ciphertexts.refresh_token_encrypted).not.toContain('refresh-live')
	expect(
		(
			(await q.get(
				`SELECT client_secret_encrypted
					FROM user_oauth_apps
					WHERE user_id = ? AND slug = ?`,
				userId,
				'google',
			)) as { client_secret_encrypted: string }
		).client_secret_encrypted,
	).not.toContain('client-secret-live')

	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
		}),
	).toBe('access-live')
	expect(
		await resolveIntegrationRefreshToken({
			env,
			userId,
			name: 'google',
		}),
	).toBe('refresh-live')
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBe('client-secret-live')

	await q.run(
		`UPDATE user_integrations
			SET access_token_encrypted = NULL, refresh_token_encrypted = NULL
			WHERE user_id = ? AND name = ?`,
		userId,
		'google',
	)
	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
		}),
	).toBeNull()

	expect(await listSecrets({ env, userId, scope: 'user' })).toEqual([])
	expect(await listUserSecretsForSearch({ env, userId })).toEqual([])
	expect(
		await resolveSecret({
			env,
			userId,
			name: 'googleAccessToken',
			scope: 'user',
			storageContext,
		}),
	).toMatchObject({ found: false })

	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})

	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
	})
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-mail',
		packageKodyId: 'mail',
	})

	const grantedAny = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-mail',
	})
	expect(grantedAny).toMatchObject({
		usageMode: 'any',
		allowedPackageIds: [],
	})

	await setIntegrationUsage({
		env,
		userId,
		name: 'google',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})
	await expect(
		assertCanUseIntegration({
			env,
			baseUrl: 'https://kody.codes',
			userId,
			name: 'google',
		}),
	).rejects.toBeInstanceOf(IntegrationPackageAccessDeniedError)
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-mail',
		packageKodyId: 'mail',
	})
	await expect(
		assertCanUseIntegration({
			env,
			baseUrl: 'https://kody.codes',
			userId,
			name: 'google',
			packageId: 'pkg-docs',
			packageKodyId: 'docs',
		}),
	).rejects.toThrow(
		buildIntegrationPackageApprovalUrl({
			baseUrl: 'https://kody.codes',
			name: 'google',
			packageId: 'pkg-docs',
			kodyId: 'docs',
		}),
	)

	const grantedDocs = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-docs',
	})
	expect(grantedDocs).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-docs', 'pkg-mail'],
	})
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-docs',
	})

	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			name: 'google-work',
		},
	})
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google-work',
		accessToken: 'work-access',
		refreshToken: 'work-refresh',
	})

	expect(await deleteIntegration({ env, userId, name: 'google-work' })).toBe(
		true,
	)
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBe('client-secret-live')

	const deletedApp = await deleteOauthAppWithConnections({
		env,
		userId,
		slug: 'google',
	})
	expect(deletedApp).toEqual({
		deleted: true,
		connectionNames: ['google'],
	})
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBeNull()
})

test('disconnecting the last user-lane connection deletes the leftover client secret', async () => {
	const userId = 'user-last-disconnect'
	await using harness = await createHarness(userId)
	const { env, q } = harness

	await upsertIntegration({ env, userId, config: googleConfig })
	await persistIntegrationTokens({
		env,
		userId,
		name: 'google',
		accessToken: 'access-live',
		refreshToken: 'refresh-live',
	})
	await persistUserOauthAppClientSecret({
		env,
		userId,
		slug: 'google',
		value: 'client-secret-live',
	})

	expect(await deleteIntegration({ env, userId, name: 'google' })).toBe(true)
	expect(
		await resolveIntegrationAccessToken({
			env,
			userId,
			name: 'google',
		}),
	).toBeNull()
	expect(
		await resolveUserOauthAppClientSecret({
			env,
			userId,
			slug: 'google',
		}),
	).toBeNull()
	expect(await listSecrets({ env, userId, scope: 'user' })).toEqual([])
})

test('lockIntegrationToPackage switches any-context usage to packages and rejects unknown packages', async () => {
	const userId = 'user-lock-usage'
	await using harness = await createHarness(userId)
	const { env, q } = harness
	await seedSavedPackage(harness.pg, {
		id: 'pkg-drafts',
		userId,
		kodyId: 'gmail-drafts',
	})
	await upsertIntegration({ env, userId, config: googleConfig })

	const grantedWhileAny = await grantIntegrationPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-drafts',
	})
	expect(grantedWhileAny).toMatchObject({
		usageMode: 'any',
		allowedPackageIds: [],
	})

	const locked = await lockIntegrationToPackage({
		env,
		userId,
		name: 'google',
		packageId: 'pkg-drafts',
	})
	expect(locked).toMatchObject({
		usageMode: 'packages',
		allowedPackageIds: ['pkg-drafts'],
	})
	await expect(
		assertCanUseIntegration({
			env,
			baseUrl: 'https://kody.codes',
			userId,
			name: 'google',
		}),
	).rejects.toBeInstanceOf(IntegrationPackageAccessDeniedError)
	await assertCanUseIntegration({
		env,
		baseUrl: 'https://kody.codes',
		userId,
		name: 'google',
		packageId: 'pkg-drafts',
		packageKodyId: 'gmail-drafts',
	})

	await expect(
		lockIntegrationToPackage({
			env,
			userId,
			name: 'google',
			packageId: 'missing-package',
		}),
	).rejects.toThrow('Saved package not found for this user.')
})
