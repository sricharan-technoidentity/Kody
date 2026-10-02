import { expect, test, vi } from 'vitest'
import { adminUserListItemFieldNames } from './admin-users.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	adminCreateUserWithPasswordSetup: vi.fn(),
	scheduleUserCreatedEvent: vi.fn(),
	loadAdminUsersData: undefined as
		| ((...args: Array<unknown>) => Promise<unknown>)
		| undefined,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/identity/admin-user-creation.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/identity/admin-user-creation.ts')
		>()
	return {
		...actual,
		adminCreateUserWithPasswordSetup: (...args: Array<unknown>) =>
			mockModule.adminCreateUserWithPasswordSetup(...args),
	}
})

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		mockModule.scheduleUserCreatedEvent(...args),
}))

vi.mock('#worker/admin/users-data.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/admin/users-data.ts')>()
	return {
		...actual,
		loadAdminUsersData: (
			...args: Parameters<typeof actual.loadAdminUsersData>
		) =>
			mockModule.loadAdminUsersData
				? mockModule.loadAdminUsersData(...args)
				: actual.loadAdminUsersData(...args),
	}
})

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs a deterministic request IP for its audit assertions.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

type UserRow = {
	id: number
	stable_user_id?: string
	username: string
	email: string
	email_verified_at?: string | null
	plan?: string | null
	entitlement_ladder?: string | null
	stripe_plan?: string | null
	stripe_customer_id?: string | null
	suspended_at?: string | null
	email_outbound_paused_at?: string | null
	email_verification_delivery_status?: string | null
	email_verification_delivery_at?: string | null
	email_verification_delivery_detail?: string | null
	email_verification_delivery_class?: string | null
	account_type?: 'person' | 'platform' | null
	deleting_at?: string | null
	created_at: string
	updated_at: string
}

type UserRoleRow = { user_id: number; role_name: RoleName }

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

/**
 * Seeds PGlite and returns an admin request environment: `APP_DB` is the
 * restricted `kody_admin` role, `APP_DB_FOR_USER` each target account's
 * writer (verification token rows).
 */
async function createAdminTestEnv(input: {
	users: Array<UserRow>
	userRoles: Array<UserRoleRow>
}) {
	const store = await createTestDb()
	for (const user of input.users) {
		const row: Record<string, unknown> = {
			password_hash: 'unused',
			...user,
			stable_user_id: user.stable_user_id ?? stableUserId(user.id),
			// Normal fixtures default to free.
			plan: user.plan === undefined ? 'free' : user.plan,
		}
		const columns = Object.keys(row)
		await store.pg.query(
			`INSERT INTO users (${columns.join(', ')})
			 VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
			Object.values(row),
		)
	}
	for (const role of input.userRoles) {
		await store.pg.query(
			`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`,
			[role.user_id, role.role_name],
		)
	}
	await store.pg.query(
		`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT max(id) FROM users), 1))`,
	)
	return {
		COOKIE_SECRET: 'secret',
		APP_DB: createPgDatabase({ connection: store.pg, role: 'kody_admin' }),
		APP_DB_FOR_USER: (userId: string) => store.forUser(userId).db,
		store,
		[Symbol.asyncDispose]: () => store[Symbol.asyncDispose](),
	}
}

const { createAdminUsersApiHandler } = await import('./admin-users.ts')

test('admin users list payload exposes only account metadata fields', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				plan: 'pro',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				email_verified_at: null,
				plan: 'free',
				stripe_plan: 'standard',
				stripe_customer_id: 'cus_member',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
		],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(Object.keys(payload).sort()).toEqual(
		[
			'availablePlans',
			'availableRoles',
			'ok',
			'page',
			'pageSize',
			'selectedUser',
			'total',
			'users',
		].sort(),
	)
	expect(payload.selectedUser).toBeNull()
	for (const user of payload.users) {
		expect(Object.keys(user).sort()).toEqual(
			[...adminUserListItemFieldNames].sort(),
		)
	}
	expect(payload.users).toEqual([
		expect.objectContaining({
			email: 'admin@example.com',
			email_verified: true,
			email_verified_at: '2026-01-01T00:00:00.000Z',
			plan: 'pro',
			manualPlan: 'pro',
			stripePlan: null,
			effectivePlan: 'pro',
			stripeCustomerLinked: false,
		}),
		expect.objectContaining({
			email: 'member@example.com',
			email_verified: false,
			email_verified_at: null,
			plan: 'free',
			manualPlan: 'free',
			stripePlan: 'standard',
			effectivePlan: 'standard',
			stripeCustomerLinked: true,
		}),
	])
})

test('admin users selected param resolves outside the current page and filter', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
			{
				id: 3,
				username: 'another-member',
				email: 'another@example.com',
				created_at: '2026-01-05 00:00:00',
				updated_at: '2026-01-06 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
			{ user_id: 3, role_name: 'user' },
		],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const listUsers = async (search: string) => {
		const response = await handler.handler({
			request: new Request(`https://example.com/admin/users.json${search}`, {
				headers: { Accept: 'application/json' },
			}),
			params: {},
			url: new URL(`https://example.com/admin/users.json${search}`),
		} as never)
		expect(response.status).toBe(200)
		return response.json()
	}

	// Selected user on a later page is still returned for the detail pane.
	const paged = await listUsers(
		`?pageSize=1&page=1&selected=${stableUserId(3)}`,
	)
	expect(
		paged.users.map((user: { stableUserId: string }) => user.stableUserId),
	).toEqual([stableUserId(1)])
	expect(paged.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(3),
			username: 'another-member',
			email: 'another@example.com',
		}),
	)

	// Selected user excluded by the active role filter is still returned.
	const filtered = await listUsers(`?role=admin&selected=${stableUserId(2)}`)
	expect(
		filtered.users.map((user: { stableUserId: string }) => user.stableUserId),
	).toEqual([stableUserId(1)])
	expect(filtered.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			username: 'member',
		}),
	)

	const missing = await listUsers(`?selected=${stableUserId(99)}`)
	expect(missing.selectedUser).toBeNull()

	const invalid = await listUsers('?selected=123')
	expect(invalid.selectedUser).toBeNull()
})

test('admin users list applies q and role filters to the slice and total', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'searchable-member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
			{
				id: 3,
				username: 'another-member',
				email: 'searchable@example.com',
				created_at: '2026-01-05 00:00:00',
				updated_at: '2026-01-06 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
			{ user_id: 3, role_name: 'user' },
		],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const listUsers = async (search: string) => {
		const response = await handler.handler({
			request: new Request(`https://example.com/admin/users.json${search}`, {
				headers: { Accept: 'application/json' },
			}),
			params: {},
			url: new URL(`https://example.com/admin/users.json${search}`),
		} as never)
		expect(response.status).toBe(200)
		return response.json()
	}

	// q matches username or email; total reflects the filtered set.
	const searchPayload = await listUsers('?q=searchable')
	expect(searchPayload.total).toBe(2)
	expect(
		searchPayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(2), stableUserId(3)])

	const rolePayload = await listUsers('?role=admin')
	expect(rolePayload.total).toBe(1)
	expect(
		rolePayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(1)])

	const combinedPayload = await listUsers('?q=searchable&role=admin')
	expect(combinedPayload.total).toBe(0)
	expect(combinedPayload.users).toEqual([])

	// Unknown role values are ignored rather than filtering everything out.
	const unknownRolePayload = await listUsers('?role=not-a-role')
	expect(unknownRolePayload.total).toBe(3)

	// Filters and pagination compose.
	const pagedPayload = await listUsers('?q=searchable&pageSize=1&page=2')
	expect(pagedPayload.total).toBe(2)
	expect(
		pagedPayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(3)])
})

test('admin users list applies verification=stalled to the slice and total', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'stalled-raul',
				email: 'a.kodycodes@raulg.dev',
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: '2020-01-01T00:00:00.000Z',
				created_at: '2020-01-01 00:00:00',
				updated_at: '2020-01-01 00:00:00',
			},
			{
				id: 2,
				username: 'fresh-accepted',
				email: 'fresh@example.com',
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: new Date().toISOString(),
				created_at: '2026-09-01 00:00:00',
				updated_at: '2026-09-01 00:00:00',
			},
			{
				id: 3,
				username: 'bounced',
				email: 'bounced@example.com',
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_at: '2020-01-01T00:00:00.000Z',
				created_at: '2020-01-01 00:00:00',
				updated_at: '2020-01-01 00:00:00',
			},
			{
				id: 4,
				username: 'already-verified',
				email: 'verified@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: '2020-01-01T00:00:00.000Z',
				created_at: '2020-01-01 00:00:00',
				updated_at: '2026-01-01 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'user' },
			{ user_id: 2, role_name: 'user' },
			{ user_id: 3, role_name: 'user' },
			{ user_id: 4, role_name: 'user' },
		],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/admin/users.json?verification=stalled',
			{ headers: { Accept: 'application/json' } },
		),
		params: {},
		url: new URL('https://example.com/admin/users.json?verification=stalled'),
	} as never)
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.total).toBe(1)
	expect(
		payload.users.map((user: { username: string }) => user.username),
	).toEqual(['stalled-raul'])

	const unknown = await handler.handler({
		request: new Request(
			'https://example.com/admin/users.json?verification=not-a-filter',
			{ headers: { Accept: 'application/json' } },
		),
		params: {},
		url: new URL(
			'https://example.com/admin/users.json?verification=not-a-filter',
		),
	} as never)
	expect(unknown.status).toBe(200)
	const unknownPayload = await unknown.json()
	expect(unknownPayload.total).toBe(4)
})

test('assign role action updates user roles and logs audit event', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'assign_role',
				stableUserId: stableUserId(2),
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.users[0].roles).toContain('admin')
	// Mutations return the updated target so the client can patch it into
	// an infinite-scroll window without resetting to the first page.
	expect(payload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			roles: expect.arrayContaining(['admin', 'user']),
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'admin', action: 'assign_role' }),
	)
})

test('remove role rejects removing the last admin account', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'solo-admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'remove_role',
				stableUserId: stableUserId(1),
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(409)
})

test('remove role removes admin when another admin remains', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'first-admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'second-admin',
				email: 'second@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
		],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'remove_role',
				stableUserId: stableUserId(2),
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	const secondAdmin = payload.users.find(
		(user: { stableUserId: string }) => user.stableUserId === stableUserId(2),
	)
	expect(secondAdmin.roles).not.toContain('admin')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'remove_role',
			result: 'success',
		}),
	)
})

test('update plan action sets, maps null to free, validates, and scopes plan changes', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				plan: 'max',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const postUpdatePlan = (body: Record<string, unknown>) =>
		handler.handler({
			request: new Request('https://example.com/admin/users.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params: {},
			url: new URL('https://example.com/admin/users.json'),
		} as never)

	const setPlanResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(2),
		plan: 'pro',
	})
	expect(setPlanResponse.status).toBe(200)
	expect((await setPlanResponse.json()).users[0].plan).toBe('pro')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)};plan=pro`,
		}),
	)

	const clearPlanResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(2),
		plan: null,
	})
	expect(clearPlanResponse.status).toBe(200)
	expect((await clearPlanResponse.json()).users[0].plan).toBe('free')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)};plan=free`,
		}),
	)

	for (const body of [
		{
			action: 'update_plan',
			stableUserId: stableUserId(2),
			plan: 'enterprise',
		},
		{ action: 'update_plan', stableUserId: stableUserId(2) },
		{ action: 'update_plan', stableUserId: 2, plan: 'pro' },
	]) {
		expect((await postUpdatePlan(body)).status).toBe(400)
	}

	const missingUserResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(42),
		plan: 'pro',
	})
	expect(missingUserResponse.status).toBe(404)
})

test('suspend, unsuspend, and resume email actions update flags and log audit events', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				email_outbound_paused_at: '2026-07-20T00:00:00.000Z',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const postAction = (body: Record<string, unknown>) =>
		handler.handler({
			request: new Request('https://example.com/admin/users.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params: {},
			url: new URL('https://example.com/admin/users.json'),
		} as never)

	const suspendResponse = await postAction({
		action: 'suspend_user',
		stableUserId: stableUserId(2),
	})
	expect(suspendResponse.status).toBe(200)
	const suspended = await suspendResponse.json()
	expect(suspended.users[0].suspended_at).toBeTruthy()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'suspend_user',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const unsuspendResponse = await postAction({
		action: 'unsuspend_user',
		stableUserId: stableUserId(2),
	})
	expect(unsuspendResponse.status).toBe(200)
	expect((await unsuspendResponse.json()).users[0].suspended_at).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'unsuspend_user',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const resumeResponse = await postAction({
		action: 'resume_email_outbound',
		stableUserId: stableUserId(2),
	})
	expect(resumeResponse.status).toBe(200)
	expect(
		(await resumeResponse.json()).users[0].email_outbound_paused_at,
	).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'resume_email_outbound',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	// Admins cannot suspend their own account (actor id is 1).
	await using selfSuspendEnv = await createAdminTestEnv({
		users: [
			{
				id: 1,
				stable_user_id: stableUserId(1),
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-01 00:00:00',
			},
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})
	const selfHandler = createAdminUsersApiHandler(
		selfSuspendEnv as unknown as Env,
	)
	const selfResponse = await selfHandler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'suspend_user',
				stableUserId: stableUserId(1),
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)
	expect(selfResponse.status).toBe(400)

	expect(
		(
			await postAction({
				action: 'suspend_user',
				stableUserId: stableUserId(42),
			})
		).status,
	).toBe(404)
})

test('admin users API returns 403 without read:user:any permission', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	await using env = await createAdminTestEnv({ users: [], userRoles: [] })
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)
	expect(response.status).toBe(403)
})

test('mark email verified and mint verify url actions update the account and log audit events', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_class: 'sender_block',
				email_verification_delivery_detail:
					'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const postAction = (body: Record<string, unknown>) =>
		handler.handler({
			request: new Request('https://example.com/admin/users.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params: {},
			url: new URL('https://example.com/admin/users.json'),
		} as never)

	const mintResponse = await postAction({
		action: 'mint_verify_url',
		stableUserId: stableUserId(2),
	})
	expect(mintResponse.status).toBe(200)
	const minted = await mintResponse.json()
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/example.com\/verify-email\?token=/,
	)
	expect(minted.users[0].email_verified).toBe(false)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'mint_verify_url',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const verifyResponse = await postAction({
		action: 'mark_email_verified',
		stableUserId: stableUserId(2),
	})
	expect(verifyResponse.status).toBe(200)
	const verified = await verifyResponse.json()
	expect(verified.users[0].email_verified).toBe(true)
	expect(verified.users[0].email_verification_delivery).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'mark_email_verified',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const alreadyVerified = await postAction({
		action: 'mint_verify_url',
		stableUserId: stableUserId(2),
	})
	expect(alreadyVerified.status).toBe(400)
})

test('create_user action returns setup link, logs audit, maps duplicate email to 409, and keeps the setup link when list refresh fails', async () => {
	const { AdminCreateUserError } =
		await import('#worker/identity/admin-user-creation.ts')
	logAuditEventSpy.mockClear()
	mockModule.scheduleUserCreatedEvent.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const createdUser = {
		userId: 9,
		stableUserId: stableUserId(9),
		email: 'new-user@example.com',
		username: 'new-user',
		setupLink: 'https://example.com/reset-password?token=setup',
		setupTokenExpiresAt: 1_800_000_000_000,
	}
	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	await using env = await createAdminTestEnv({
		users: [
			{
				id: 9,
				username: 'new-user',
				email: 'new-user@example.com',
				email_verified_at: '2026-09-10T00:00:00.000Z',
				plan: 'free',
				created_at: '2026-09-10 00:00:00',
				updated_at: '2026-09-10 00:00:00',
			},
		],
		userRoles: [{ user_id: 9, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	async function postCreateUser(body: Record<string, unknown>, search = '') {
		const href = `https://example.com/admin/users.json${search}`
		return handler.handler({
			request: new Request(href, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params: {},
			url: new URL(href),
		} as never)
	}

	const created = await postCreateUser({
		action: 'create_user',
		email: 'new-user@example.com',
		username: 'new-user',
	})
	expect(created.status).toBe(200)
	const createdPayload = await created.json()
	expect(createdPayload.createdUser).toEqual({
		stableUserId: createdUser.stableUserId,
		email: createdUser.email,
		username: createdUser.username,
		setupLink: createdUser.setupLink,
		setupTokenExpiresAt: createdUser.setupTokenExpiresAt,
	})
	expect(createdPayload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: createdUser.stableUserId,
			username: createdUser.username,
			email: createdUser.email,
		}),
	)
	expect(createdPayload.users).toEqual([
		expect.objectContaining({ stableUserId: createdUser.stableUserId }),
	])
	expect(createdPayload.createdUserInFilteredList).toBe(true)

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const roleFiltered = await postCreateUser(
		{
			action: 'create_user',
			email: 'new-user@example.com',
			username: 'new-user',
		},
		'?role=admin',
	)
	expect(roleFiltered.status).toBe(200)
	expect((await roleFiltered.json()).createdUserInFilteredList).toBe(false)

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const searchFiltered = await postCreateUser(
		{
			action: 'create_user',
			email: 'new-user@example.com',
			username: 'new-user',
		},
		'?q=nobody-matches',
	)
	expect(searchFiltered.status).toBe(200)
	expect((await searchFiltered.json()).createdUserInFilteredList).toBe(false)

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const searchMatch = await postCreateUser(
		{
			action: 'create_user',
			email: 'new-user@example.com',
			username: 'new-user',
		},
		'?q=new-user',
	)
	expect(searchMatch.status).toBe(200)
	expect((await searchMatch.json()).createdUserInFilteredList).toBe(true)

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const verificationFiltered = await postCreateUser(
		{
			action: 'create_user',
			email: 'new-user@example.com',
			username: 'new-user',
		},
		'?verification=stalled',
	)
	expect(verificationFiltered.status).toBe(200)
	expect((await verificationFiltered.json()).createdUserInFilteredList).toBe(
		false,
	)
	expect(mockModule.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env,
		user: {
			id: createdUser.stableUserId,
			username: createdUser.username,
			email: createdUser.email,
		},
		source: 'admin',
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'create_user',
			result: 'success',
		}),
	)

	mockModule.adminCreateUserWithPasswordSetup.mockRejectedValueOnce(
		new AdminCreateUserError('email_exists', 'That email is already in use.'),
	)
	const duplicate = await postCreateUser({
		action: 'create_user',
		email: 'new-user@example.com',
	})
	expect(duplicate.status).toBe(409)
	expect(await duplicate.json()).toEqual({
		ok: false,
		error: 'That email is already in use.',
		code: 'email_exists',
	})

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	mockModule.loadAdminUsersData = async () => {
		throw new Error('list refresh failed')
	}
	consoleWarn.mockImplementation(() => {})
	try {
		const refreshFailed = await postCreateUser({
			action: 'create_user',
			email: 'refresh-fail@example.com',
			username: 'refresh-fail',
		})
		expect(refreshFailed.status).toBe(200)
		const refreshFailedPayload = await refreshFailed.json()
		expect(refreshFailedPayload.ok).toBe(true)
		expect(refreshFailedPayload.listRefreshFailed).toBe(true)
		expect(refreshFailedPayload.createdUser).toEqual({
			stableUserId: createdUser.stableUserId,
			email: createdUser.email,
			username: createdUser.username,
			setupLink: createdUser.setupLink,
			setupTokenExpiresAt: createdUser.setupTokenExpiresAt,
		})
		expect(refreshFailedPayload.updatedUser).toEqual(
			expect.objectContaining({
				stableUserId: createdUser.stableUserId,
				username: createdUser.username,
			}),
		)
		expect(refreshFailedPayload.createdUserInFilteredList).toBe(true)
		expect(consoleWarn).toHaveBeenCalledWith(
			'admin-users-create-list-refresh-failed',
			expect.any(Error),
		)
	} finally {
		mockModule.loadAdminUsersData = undefined
	}
})
