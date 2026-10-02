import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:role:any']
		: ['read:role:own']
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
			userId: 'stable-admin',
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

/** The seeded RBAC catalog, read as the restricted admin role. */
async function createRolesTestEnv() {
	const store = await createTestDb()
	return {
		COOKIE_SECRET: 'secret',
		APP_DB: createPgDatabase({ connection: store.pg, role: 'kody_admin' }),
		[Symbol.asyncDispose]: () => store[Symbol.asyncDispose](),
	}
}

const { createAdminRolesApiHandler } = await import('./admin-roles.ts')

test('admin roles list returns roles and attached permissions', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createRolesTestEnv()
	const handler = createAdminRolesApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/roles.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/roles.json'),
	} as never)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		roles: Array<{ name: string; permissions: Array<string> }>
	}
	const byName = new Map(payload.roles.map((role) => [role.name, role]))
	expect([...byName.keys()].sort()).toEqual(['admin', 'user'])
	expect(byName.get('user')?.permissions).toContain('read:user:own')
	expect(byName.get('admin')?.permissions).toContain('read:role:any')
})

test('admin roles API returns 403 without read:role:any permission', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	await using env = await createRolesTestEnv()
	const handler = createAdminRolesApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/roles.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/roles.json'),
	} as never)
	expect(response.status).toBe(403)
})
