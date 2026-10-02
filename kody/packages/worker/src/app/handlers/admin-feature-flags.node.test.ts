import { createTestFeatureFlagsDb } from '#worker/test-support/aws/test-feature-flags-db.ts'
import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
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

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

function createAdminActor(roles: Array<RoleName>) {
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
			userId: stableUserId(1),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

const { createAdminFeatureFlagsApiHandler } =
	await import('./admin-feature-flags.ts')

function createHandlerRequest(
	input: {
		method?: string
		body?: unknown
	} = {},
) {
	return {
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: input.method ?? 'GET',
			headers: {
				Accept: 'application/json',
				...(input.body === undefined
					? {}
					: { 'Content-Type': 'application/json' }),
			},
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never
}

test('admin feature flags HTTP lifecycle: auth, list, set_global, and validation errors', async () => {
	await using db = await createTestFeatureFlagsDb({
		users: [{ id: 1, username: 'admin-user', stable_user_id: stableUserId(1) }],
	})
	const env = {
		COOKIE_SECRET: 'secret',
		APP_DB: db,
		FLAG_EXPOSURES: {},
	} as unknown as Env
	const handler = createAdminFeatureFlagsApiHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const forbidden = await handler.handler(createHandlerRequest())
	expect(forbidden.status).toBe(403)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	logAuditEventSpy.mockClear()

	const listResponse = await handler.handler(createHandlerRequest())
	expect(listResponse.status).toBe(200)
	const listBody = (await listResponse.json()) as {
		ok: boolean
		featureFlags: Array<{ key: string }>
	}
	expect(listBody).toMatchObject({ ok: true })
	expect(listBody.featureFlags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				stale: false,
				defaultEnabled: false,
				global: null,
				overrides: [],
			}),
		]),
	)

	const setGlobalResponse = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_global',
				key: 'demo-indicator',
				enabled: true,
				rolloutPercent: 25,
				note: 'canary',
			},
		}),
	)
	expect(setGlobalResponse.status).toBe(200)
	const setGlobalBody = (await setGlobalResponse.json()) as {
		ok: boolean
		featureFlags: Array<{ key: string }>
	}
	expect(setGlobalBody).toMatchObject({ ok: true })
	expect(setGlobalBody.featureFlags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				global: expect.objectContaining({
					enabled: true,
					rolloutPercent: 25,
					audience: 'everyone',
					note: 'canary',
					updatedByStableUserId: stableUserId(1),
				}),
			}),
		]),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'feature_flag_set_global',
			result: 'success',
			reason: 'key=demo-indicator;enabled=true;rollout_percent=25',
		}),
	)

	logAuditEventSpy.mockClear()
	const setAudienceResponse = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_global',
				key: 'demo-indicator',
				enabled: false,
				rolloutPercent: null,
				audience: 'experiments_opt_in',
				note: 'opt-in canary',
			},
		}),
	)
	expect(setAudienceResponse.status).toBe(200)
	const setAudienceBody = (await setAudienceResponse.json()) as {
		ok: boolean
		featureFlags: Array<{ key: string }>
	}
	expect(setAudienceBody).toMatchObject({ ok: true })
	expect(setAudienceBody.featureFlags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				global: expect.objectContaining({
					enabled: false,
					rolloutPercent: null,
					audience: 'experiments_opt_in',
					note: 'opt-in canary',
				}),
			}),
		]),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'feature_flag_set_global',
			result: 'success',
			reason:
				'key=demo-indicator;enabled=false;rollout_percent=null;audience=experiments_opt_in',
		}),
	)

	const unknownKeyResponse = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_global',
				key: 'not-a-real-flag',
				enabled: true,
				rolloutPercent: null,
			},
		}),
	)
	expect(unknownKeyResponse.status).toBe(400)
	await expect(unknownKeyResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.any(String),
	})

	const deleteRegistryResponse = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'delete_stale',
				key: 'demo-indicator',
			},
		}),
	)
	expect(deleteRegistryResponse.status).toBe(400)
	await expect(deleteRegistryResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.any(String),
	})
})

test('admin feature flags set_user_override validates user identity and existence', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using db = await createTestFeatureFlagsDb({
		users: [
			{ id: 1, username: 'admin-user', stable_user_id: stableUserId(1) },
			{ id: 2, username: 'jane', stable_user_id: stableUserId(2) },
		],
	})
	const handler = createAdminFeatureFlagsApiHandler({
		COOKIE_SECRET: 'secret',
		APP_DB: db,
		FLAG_EXPOSURES: {},
	} as unknown as Env)

	const neither = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
			},
		}),
	)
	expect(neither.status).toBe(400)
	await expect(neither.json()).resolves.toMatchObject({
		ok: false,
		error: expect.any(String),
	})

	const both = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				stableUserId: stableUserId(2),
				username: 'jane',
			},
		}),
	)
	expect(both.status).toBe(400)
	await expect(both.json()).resolves.toMatchObject({
		ok: false,
		error: expect.any(String),
	})

	const missingId = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				stableUserId: stableUserId(404),
			},
		}),
	)
	expect(missingId.status).toBe(404)
	await expect(missingId.json()).resolves.toMatchObject({
		ok: false,
		error: expect.any(String),
	})

	const byUsername = await handler.handler(
		createHandlerRequest({
			method: 'POST',
			body: {
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				username: 'jane',
			},
		}),
	)
	expect(byUsername.status).toBe(200)
	const byUsernameBody = (await byUsername.json()) as {
		ok: boolean
		featureFlags: Array<{ key: string }>
	}
	expect(byUsernameBody).toMatchObject({ ok: true })
	expect(byUsernameBody.featureFlags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				overrides: [
					expect.objectContaining({
						stableUserId: stableUserId(2),
						username: 'jane',
						enabled: true,
					}),
				],
			}),
		]),
	)
})
