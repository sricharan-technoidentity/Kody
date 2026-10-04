import {
	createTestPg,
	createTestAuditPg,
} from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

// These tests assert real `audit_events` rows written through the actual
// audit pipeline, so opt out of the shared audit-log-spy setup mock.
vi.unmock('#worker/audit-log.ts')
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getPlatformOauthAppClientSecret } from '#worker/integrations/platform-apps.ts'
import { adminPlatformOauthAppDeleteCapability } from './admin-platform-oauth-app-delete.ts'
import { adminPlatformOauthAppListCapability } from './admin-platform-oauth-app-list.ts'
import { adminPlatformOauthAppSaveCapability } from './admin-platform-oauth-app-save.ts'

async function createHarness() {
	const sqlite = await createTestPg()

	const auditSqlite = await createTestAuditPg()

	const env = {
		APP_DB: createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
		AUDIT_DB: createPgDatabase({
			connection: auditSqlite,
			role: 'kody_audit_writer',
		}),
		SECRET_KMS: testSecretKms,
	} as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'admin-user-1',
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	} as CapabilityContext
	return { sqlite, auditSqlite, env, ctx }
}

const saveInput = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential' as const,
	allowedScopes: ['repo', 'read:user'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com'],
}

test('save/list/delete platform OAuth apps never expose the client secret and write audit rows', async () => {
	const { auditSqlite, ctx, env } = await createHarness()

	const saved = await adminPlatformOauthAppSaveCapability.handler(
		saveInput,
		ctx,
	)
	expect(saved.app).toMatchObject({
		slug: 'github',
		clientId: 'platform-github-client-id',
		enabled: true,
	})
	expect(JSON.stringify(saved)).not.toContain(
		'platform-github-client-secret-value',
	)

	const disabled = await adminPlatformOauthAppSaveCapability.handler(
		{
			slug: 'github',
			clientId: saveInput.clientId,
			tokenUrl: saveInput.tokenUrl,
			authorizeUrl: saveInput.authorizeUrl,
			flow: 'confidential',
			enabled: false,
		},
		ctx,
	)
	expect(disabled.app.enabled).toBe(false)
	await expect(
		getPlatformOauthAppClientSecret({
			db: env.APP_DB,
			env,
			slug: 'github',
		}),
	).resolves.toBe('platform-github-client-secret-value')

	const listed = await adminPlatformOauthAppListCapability.handler({}, ctx)
	expect(listed.apps).toHaveLength(1)
	expect(listed.apps[0]).toMatchObject({
		slug: 'github',
		hasClientSecret: true,
	})
	expect(JSON.stringify(listed)).not.toContain(
		'platform-github-client-secret-value',
	)

	const deleted = await adminPlatformOauthAppDeleteCapability.handler(
		{ slug: 'github' },
		ctx,
	)
	expect(deleted).toEqual({ deleted: true })

	const auditActions = (await pgQuery(auditSqlite).all(
		'SELECT action, result FROM audit_events ORDER BY id ASC',
	)) as Array<{ action: string; result: string }>
	expect(auditActions).toEqual([
		{ action: 'adminPlatformOauthAppSave', result: 'success' },
		{ action: 'adminPlatformOauthAppSave', result: 'success' },
		{ action: 'adminPlatformOauthAppList', result: 'success' },
		{ action: 'adminPlatformOauthAppDelete', result: 'success' },
	])
})

test('delete refuses while connections exist and records the failure in the audit log', async () => {
	const { sqlite, auditSqlite, ctx } = await createHarness()
	await adminPlatformOauthAppSaveCapability.handler(saveInput, ctx)
	await pgQuery(sqlite).run(
		`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug
			) VALUES (?, ?, NULL, ?)`,
		'user-1',
		'github',
		'github',
	)

	await expect(
		adminPlatformOauthAppDeleteCapability.handler({ slug: 'github' }, ctx),
	).rejects.toThrow('still has 1 user connection')

	const listed = await adminPlatformOauthAppListCapability.handler({}, ctx)
	expect(listed.apps[0]?.connectionCount).toBe(1)

	const failures = (await pgQuery(auditSqlite).all(
		`SELECT action FROM audit_events WHERE result = 'failure' ORDER BY id ASC`,
	)) as Array<{ action: string }>
	expect(failures).toEqual([{ action: 'adminPlatformOauthAppDelete' }])
})

test('enabling a confidential app without a client secret is an McpCallerError with audit failure', async () => {
	const { ctx, auditSqlite } = await createHarness()
	await expect(
		adminPlatformOauthAppSaveCapability.handler(
			{
				slug: 'github',
				clientId: saveInput.clientId,
				clientSecret: null,
				tokenUrl: saveInput.tokenUrl,
				authorizeUrl: saveInput.authorizeUrl,
				flow: 'confidential',
			},
			ctx,
		),
	).rejects.toBeInstanceOf(McpCallerError)

	const failures = (await pgQuery(auditSqlite).all(
		`SELECT action, result FROM audit_events WHERE result = 'failure' ORDER BY id ASC`,
	)) as Array<{ action: string; result: string }>
	expect(failures).toEqual([
		{ action: 'adminPlatformOauthAppSave', result: 'failure' },
	])
})
