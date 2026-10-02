import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	updatePackagesForUsernameChange: vi.fn(),
	republishCommunityListingsAfterUsernameChange: vi.fn(),
}))

vi.mock('#worker/package-registry/username-change-packages.ts', () => ({
	updatePackagesForUsernameChange: (...args: Array<unknown>) =>
		mocks.updatePackagesForUsernameChange(...args),
	republishCommunityListingsAfterUsernameChange: (...args: Array<unknown>) =>
		mocks.republishCommunityListingsAfterUsernameChange(...args),
}))

import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountProfileApiHandler } from './account-profile.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { reservedUsernamesKvKey } from '#worker/identity/reserved-username-settings.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/** Seeds accounts `ids[i] = i + 1`; every request runs on account 1's writer. */
async function createProfileStore(usernames: Array<string>) {
	const store = await createTestDb()
	for (const [index, username] of usernames.entries()) {
		await store.pg.query(
			`INSERT INTO users (id, email, username, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ($1, $2, $3, 'unused', $4, $5, $5)`,
			[
				index + 1,
				`${username}@example.com`,
				username,
				testStableUserIdFromEmail(`${username}@example.com`),
				new Date(0).toISOString(),
			],
		)
	}
	return store
}

async function readUser(store: TestDb, id: number) {
	return (
		await store.pg.query<{
			username: string
			display_name: string | null
			bio: string | null
			profile_visibility: string
		}>(
			`SELECT username, display_name, bio, profile_visibility FROM users WHERE id = $1`,
			[id],
		)
	).rows[0]
}

async function readUsernameRedirects(store: TestDb) {
	return (
		await store.pg.query<{ old_username: string; user_id: string }>(
			`SELECT old_username, user_id FROM username_redirects ORDER BY old_username`,
		)
	).rows
}

function sessionFor(username: string): AuthSession {
	return {
		stableUserId: testStableUserIdFromEmail(`${username}@example.com`),
		email: `${username}@example.com`,
		rememberMe: false,
	}
}

async function createRequest(input: {
	session: AuthSession
	method?: string
	body?: Record<string, unknown>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/profile.json', {
		method: input.method ?? 'GET',
		headers: {
			Cookie: cookie,
			...(input.body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: input.body ? JSON.stringify(input.body) : undefined,
	})
}

/** The signed-in account's request env: its own scoped writer. */
function createEnv(store: TestDb, session: AuthSession, kv?: KVNamespace) {
	return {
		APP_DB: store.forUser(session.stableUserId).db,
		COOKIE_SECRET: testCookieSecret,
		APP_BASE_URL: 'http://example.com',
		...(kv ? { BUNDLE_ARTIFACTS_KV: kv } : {}),
	} as unknown as Env
}

async function runHandler(
	handler: ReturnType<typeof createAccountProfileApiHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

beforeEach(() => {
	mocks.updatePackagesForUsernameChange.mockReset()
	mocks.republishCommunityListingsAfterUsernameChange.mockReset()
	mocks.updatePackagesForUsernameChange.mockResolvedValue({
		updatedPackages: [],
		skippedPackages: [],
	})
	mocks.republishCommunityListingsAfterUsernameChange.mockResolvedValue({
		republishedPackageIds: [],
		warnings: [],
	})
})

test('account profile API returns email and username for the signed-in user', async () => {
	await using store = await createProfileStore(['current-user'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const response = await runHandler(handler, await createRequest({ session }))

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'current-user',
		displayName: 'current-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})
	// Reads are not audited.
	expect(logAuditEventSpy).not.toHaveBeenCalled()
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API updates username for the signed-in user and retires the old one', async () => {
	await using store = await createProfileStore(['current-user'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))
	mocks.updatePackagesForUsernameChange.mockResolvedValueOnce({
		updatedPackages: [
			{
				packageId: 'pkg-1',
				kodyId: 'demo',
				previousName: '@current-user/demo',
				nextName: '@next-jane/demo',
				publishedCommit: 'abc',
				changedPaths: ['package.json'],
				shouldRepublishCommunityListing: true,
			},
		],
		skippedPackages: [],
	})
	mocks.republishCommunityListingsAfterUsernameChange.mockResolvedValueOnce({
		republishedPackageIds: ['pkg-1'],
		warnings: [],
	})

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'Next-Jane' },
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		email: 'current-user@example.com',
		username: 'next-jane',
		displayName: 'next-jane',
		bio: null,
		profileVisibility: 'public',
		packagesUpdated: 1,
		communityListingsRepublished: 1,
		packageUpdateMessage: 'Updated 1 package to the new @next-jane scope.',
	})
	expect((await readUser(store, 1))?.username).toBe('next-jane')
	// Links shared under the old name keep resolving to this account.
	expect(await readUsernameRedirects(store)).toEqual([
		{ old_username: 'current-user', user_id: session.stableUserId },
	])
	expect(mocks.updatePackagesForUsernameChange).toHaveBeenCalledWith(
		expect.objectContaining({
			previousUsername: 'current-user',
			nextUsername: 'next-jane',
		}),
	)
	expect(
		mocks.republishCommunityListingsAfterUsernameChange,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			packageIds: ['pkg-1'],
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'success',
		}),
	)
})

test('account profile API treats an unchanged username as a no-op so grandfathered reserved usernames can still save profile fields', async () => {
	// 'kody' is on the reserved username list; an account that already holds
	// it must still be able to save display name / bio / visibility.
	await using store = await createProfileStore(['kody'])
	const session = sessionFor('kody')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'kody', displayName: 'Kody the Koala', bio: 'Hi' },
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		username: 'kody',
		displayName: 'Kody the Koala',
		bio: 'Hi',
	})
	expect(await readUser(store, 1)).toMatchObject({
		username: 'kody',
		display_name: 'Kody the Koala',
		bio: 'Hi',
	})
	expect(logAuditEventSpy).not.toHaveBeenCalledWith(
		expect.objectContaining({ action: 'update_username' }),
	)
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API rejects username changes when package updates fail', async () => {
	await using store = await createProfileStore(['current-user'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))
	mocks.updatePackagesForUsernameChange.mockRejectedValueOnce(
		new Error('sync failed'),
	)

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'next-jane' },
		}),
	)

	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		ok: false,
		error:
			'Username was not changed because package updates failed: sync failed',
	})
	// The claimed name is rolled back and nothing is retired.
	expect((await readUser(store, 1))?.username).toBe('current-user')
	expect(await readUsernameRedirects(store)).toEqual([])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'failure',
			reason: 'package_scope_update_failed',
		}),
	)
})

test('account profile API rejects invalid or duplicate usernames', async () => {
	await using store = await createProfileStore(['current-user', 'taken-jane'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const invalidResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'bad username' },
		}),
	)
	expect(invalidResponse.status).toBe(400)

	const reservedResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'kody' },
		}),
	)
	expect(reservedResponse.status).toBe(400)
	expect(await reservedResponse.json()).toEqual({
		ok: false,
		error: '`kody` is reserved.',
	})

	// RLS hides the other account, so the unique constraint is what refuses.
	const duplicateResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'Taken-Jane' },
		}),
	)
	expect(duplicateResponse.status).toBe(409)
	expect(await duplicateResponse.json()).toEqual({
		ok: false,
		error: '`taken-jane` is taken.',
	})
	expect((await readUser(store, 1))?.username).toBe('current-user')
	expect((await readUser(store, 2))?.username).toBe('taken-jane')
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
	// Only the duplicate attempt is audited; validation rejections are not.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'failure',
			reason: 'username_exists',
		}),
	)
})

test('account profile API does not report success when the requested username did not persist', async () => {
	await using store = await createProfileStore(['jklotz08'])
	// Simulates a write that reports success but leaves the row unchanged.
	await store.pg.exec(`
		CREATE FUNCTION test_keep_username() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN NEW.username := OLD.username; RETURN NEW; END $$;
		CREATE TRIGGER test_keep_username BEFORE UPDATE ON users
		FOR EACH ROW EXECUTE FUNCTION test_keep_username();
	`)
	const session = sessionFor('jklotz08')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'jklotz' },
		}),
	)

	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Username was not changed to `jklotz`.',
	})
	expect((await readUser(store, 1))?.username).toBe('jklotz08')
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API round trips displayName, bio, and visibility', async () => {
	await using store = await createProfileStore(['current-user', 'bystander'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: {
				displayName: '  Current User  ',
				bio: 'I build packages',
				profileVisibility: 'private',
			},
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'current-user',
		displayName: 'Current User',
		bio: 'I build packages',
		avatarUrl: null,
		profileVisibility: 'private',
		formerEmails: [],
	})
	expect(await readUser(store, 1)).toMatchObject({
		display_name: 'Current User',
		bio: 'I build packages',
		profile_visibility: 'private',
	})
	expect(await readUser(store, 2)).toMatchObject({
		display_name: null,
		bio: null,
		profile_visibility: 'public',
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_profile',
			result: 'success',
		}),
	)

	const getResponse = await runHandler(
		handler,
		await createRequest({ session }),
	)
	expect(await getResponse.json()).toMatchObject({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})

	// Blank fields clear back to null.
	const clearResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { displayName: ' ', bio: null },
		}),
	)
	expect(await clearResponse.json()).toMatchObject({
		displayName: 'current-user',
		bio: null,
	})
	expect(await readUser(store, 1)).toMatchObject({
		display_name: null,
		bio: null,
	})
})

test('account profile API validates profile field updates', async () => {
	await using store = await createProfileStore(['current-user'])
	const session = sessionFor('current-user')
	const handler = createAccountProfileApiHandler(createEnv(store, session))

	const invalidVisibility = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { profileVisibility: 'friends' },
		}),
	)
	expect(invalidVisibility.status).toBe(400)
	expect(await invalidVisibility.json()).toEqual({
		ok: false,
		error: 'Profile visibility is invalid.',
	})

	const invalidDisplayName = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { displayName: 'x'.repeat(51) },
		}),
	)
	expect(invalidDisplayName.status).toBe(400)
	expect(await invalidDisplayName.json()).toEqual({
		ok: false,
		error: 'Display name must be at most 50 characters.',
	})
	expect((await readUser(store, 1))?.display_name).toBeNull()
})

test('account profile username change consults KV reserved additions and removals', async () => {
	await using store = await createProfileStore(['current-user'])
	const session = sessionFor('current-user')
	const kv = {
		async get(key: string, type?: string) {
			if (key !== reservedUsernamesKvKey) return null
			const raw = JSON.stringify({
				added: ['brandnew'],
				removed: ['faq'],
				updatedAt: '2026-09-02T00:00:00.000Z',
				updatedBy: 'admin-stable-id',
			})
			return type === 'json' ? JSON.parse(raw) : raw
		},
	} as unknown as KVNamespace
	const handler = createAccountProfileApiHandler(createEnv(store, session, kv))

	const addedResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'brandnew' },
		}),
	)
	expect(addedResponse.status).toBe(400)
	expect(await addedResponse.json()).toEqual({
		ok: false,
		error: '`brandnew` is reserved.',
	})

	const unreservedResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'faq' },
		}),
	)
	expect(unreservedResponse.status).toBe(200)
	expect((await readUser(store, 1))?.username).toBe('faq')
})
