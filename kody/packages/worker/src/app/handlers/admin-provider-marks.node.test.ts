import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'
import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
} from '#worker/test-support/images-binding.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const { createAdminProviderMarksApiHandler } =
	await import('./admin-provider-marks.ts')

function createActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: '1'.padStart(64, '0'),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

async function createHarness() {
	const sqlite = await createTestPg()

	const env = {
		APP_DB: createPgDatabase({ connection: sqlite, role: 'kody_admin' }),
		SECRET_KMS: testSecretKms,
		COMMUNITY_ASSETS: {
			async put() {},
			async get() {
				return null
			},
			async delete() {},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	return { env }
}

function postRequest(body: Record<string, unknown>) {
	return new Request('https://example.com/admin/provider-marks.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

test('admin provider marks API saves and lists operator marks', async () => {
	const { env } = await createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminProviderMarksApiHandler(env)

	const saved = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'google',
			label: 'Google',
			aliases: ['accounts.google.com'],
			logoBase64: bytesToBase64(tinyPngBytes),
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(saved.status).toBe(200)
	const savedBody = (await saved.json()) as {
		ok: true
		marks: Array<{ slug: string; logoPath: string | null }>
	}
	expect(savedBody.marks[0]?.slug).toBe('google')
	expect(savedBody.marks[0]?.logoPath).toMatch(
		/^\/integrations\/provider-marks\/google/,
	)

	const listed = await handler.handler({
		request: new Request('https://example.com/admin/provider-marks.json'),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(listed.status).toBe(200)

	const deleted = await handler.handler({
		request: postRequest({
			action: 'delete',
			slug: 'google',
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(deleted.status).toBe(200)
	const deletedBody = (await deleted.json()) as {
		ok: true
		marks: Array<{ slug: string }>
	}
	expect(deletedBody.marks).toEqual([])
})

test('admin provider marks API rejects a logo write when storage is missing without creating the mark', async () => {
	const { env } = await createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminProviderMarksApiHandler({
		...env,
		COMMUNITY_ASSETS: undefined,
	} as Env)

	const saved = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'google',
			label: 'Google',
			logoBase64: bytesToBase64(tinyPngBytes),
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(saved.status).toBe(503)

	const listed = await createAdminProviderMarksApiHandler(env).handler({
		request: new Request('https://example.com/admin/provider-marks.json'),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	const listedBody = (await listed.json()) as {
		ok: true
		marks: Array<{ slug: string }>
	}
	expect(listedBody.marks).toEqual([])
})

test('admin provider marks API rejects delete when logo storage is missing', async () => {
	const { env } = await createHarness()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const handler = createAdminProviderMarksApiHandler(env)
	const saved = await handler.handler({
		request: postRequest({
			action: 'save',
			slug: 'google',
			label: 'Google',
			logoBase64: bytesToBase64(tinyPngBytes),
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(saved.status).toBe(200)

	const deleted = await createAdminProviderMarksApiHandler({
		...env,
		COMMUNITY_ASSETS: undefined,
	} as Env).handler({
		request: postRequest({
			action: 'delete',
			slug: 'google',
		}),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	expect(deleted.status).toBe(503)

	const listed = await handler.handler({
		request: new Request('https://example.com/admin/provider-marks.json'),
		params: {},
		url: new URL('https://example.com/admin/provider-marks.json'),
	})
	const listedBody = (await listed.json()) as {
		ok: true
		marks: Array<{ slug: string }>
	}
	expect(listedBody.marks.map((mark) => mark.slug)).toEqual(['google'])
})
