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

vi.unmock('#worker/audit-log.ts')
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
} from '#worker/test-support/images-binding.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { adminPlatformProviderMarkDeleteCapability } from './admin-platform-provider-mark-delete.ts'
import { adminPlatformProviderMarkListCapability } from './admin-platform-provider-mark-list.ts'
import { adminPlatformProviderMarkSaveCapability } from './admin-platform-provider-mark-save.ts'

async function createHarness() {
	const sqlite = await createTestPg()

	const auditSqlite = await createTestAuditPg()

	const objects = new Map<string, Uint8Array>()
	const env = {
		APP_DB: createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
		AUDIT_DB: createPgDatabase({
			connection: auditSqlite,
			role: 'kody_audit_writer',
		}),
		SECRET_KMS: testSecretKms,
		COMMUNITY_ASSETS: {
			async put(key: string, bytes: Uint8Array) {
				objects.set(key, bytes)
			},
			async get(key: string) {
				return objects.has(key) ? { body: objects.get(key) } : null
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
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
	return { env, ctx, objects, auditSqlite }
}

test('save/list/delete provider marks store a fitted logo and write audit rows', async () => {
	const { ctx, auditSqlite } = await createHarness()

	const saved = await adminPlatformProviderMarkSaveCapability.handler(
		{
			slug: 'Google',
			label: 'Google',
			aliases: ['accounts.google.com', 'googleapis.com'],
			logoBase64: bytesToBase64(tinyPngBytes),
		},
		ctx,
	)
	expect(saved.mark).toMatchObject({
		slug: 'google',
		label: 'Google',
	})
	expect(saved.mark.aliases).toEqual([])
	expect(saved.mark.logoPath).toMatch(/^\/integrations\/provider-marks\/google/)

	const listed = await adminPlatformProviderMarkListCapability.handler({}, ctx)
	expect(listed.marks).toHaveLength(1)
	expect(listed.marks[0]?.slug).toBe('google')

	const deleted = await adminPlatformProviderMarkDeleteCapability.handler(
		{ slug: 'google' },
		ctx,
	)
	expect(deleted).toEqual({ deleted: true })
	expect(
		(await adminPlatformProviderMarkListCapability.handler({}, ctx)).marks,
	).toEqual([])
	const auditActions = (await pgQuery(auditSqlite).all(
		'SELECT action, result FROM audit_events ORDER BY id ASC',
	)) as Array<{ action: string; result: string }>
	expect(auditActions).toEqual([
		{ action: 'adminPlatformProviderMarkSave', result: 'success' },
		{ action: 'adminPlatformProviderMarkList', result: 'success' },
		{ action: 'adminPlatformProviderMarkDelete', result: 'success' },
		{ action: 'adminPlatformProviderMarkList', result: 'success' },
	])
})

test('delete provider mark fails when logo storage is missing', async () => {
	const { ctx, env } = await createHarness()
	await adminPlatformProviderMarkSaveCapability.handler(
		{
			slug: 'google',
			label: 'Google',
			logoBase64: bytesToBase64(tinyPngBytes),
		},
		ctx,
	)
	const missingStorageCtx = {
		...ctx,
		env: { ...env, COMMUNITY_ASSETS: undefined },
	} as typeof ctx

	await expect(
		adminPlatformProviderMarkDeleteCapability.handler(
			{ slug: 'google' },
			missingStorageCtx,
		),
	).rejects.toThrow(McpCallerError)
	expect(
		(await adminPlatformProviderMarkListCapability.handler({}, ctx)).marks,
	).toHaveLength(1)
})
