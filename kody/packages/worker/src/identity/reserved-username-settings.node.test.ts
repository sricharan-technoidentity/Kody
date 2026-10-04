import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	addReservedUsernames,
	clearReservedUsernameSettingsCacheForTests,
	findReservedUsernameConflicts,
	getEffectiveReservedUsernameError,
	isEffectivelyReservedUsername,
	loadReservedUsernameRecord,
	PermanentlyReservedUsernameError,
	removeReservedUsernames,
	reservedUsernamesKvKey,
	reservedUsernamesKvReadFailedLogKey,
} from './reserved-username-settings.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
	usernameRequirements,
} from './username.ts'

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

function createEnv(kv?: KVNamespace) {
	return {
		BUNDLE_ARTIFACTS_KV: kv,
		APP_DB: {} as SqlDatabase,
	} as unknown as Env
}

test('reserved username KV overrides, fallback, memo, permanent lock, and conflicts', async () => {
	expect(await isEffectivelyReservedUsername('faq')).toBe(true)
	expect(await isEffectivelyReservedUsername('alice')).toBe(false)

	const overrideKv = createMemoryKv({
		[reservedUsernamesKvKey]: JSON.stringify({
			added: ['brandnew'],
			removed: ['faq'],
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const envWithOverride = createEnv(overrideKv)
	expect(await isEffectivelyReservedUsername('brandnew', envWithOverride)).toBe(
		true,
	)
	expect(
		await isEffectivelyReservedUsername('super-brandnew', envWithOverride),
	).toBe(true)
	expect(await isEffectivelyReservedUsername('faq', envWithOverride)).toBe(
		false,
	)
	expect(
		await isEffectivelyReservedUsername('super-faq', envWithOverride),
	).toBe(false)
	expect(await isEffectivelyReservedUsername('kody', envWithOverride)).toBe(
		true,
	)
	expect(
		await getEffectiveReservedUsernameError('brandnew', envWithOverride),
	).not.toBeNull()
	expect(await getEffectiveReservedUsernameError('faq', envWithOverride)).toBe(
		null,
	)
	expect(
		await getEffectiveUsernameValidationError('brandnew', envWithOverride),
	).not.toBeNull()
	expect(
		await getEffectiveUsernameValidationError('faq', envWithOverride),
	).toBe(null)

	clearReservedUsernameSettingsCacheForTests()
	const swearKv = createMemoryKv({
		[reservedUsernamesKvKey]: JSON.stringify({
			added: ['fuck'],
			removed: [],
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const swearEnv = createEnv(swearKv)
	expect(await getEffectiveUsernameValidationError('fuckyou', swearEnv)).toBe(
		'This username is reserved.',
	)
	expect(await getEffectiveUsernameValidationError('FuckYou', swearEnv)).toBe(
		usernameRequirements,
	)
	expect(
		await getEffectiveUsernameValidationError(
			normalizeUsername('FuckYou'),
			swearEnv,
		),
	).toBe('This username is reserved.')
	expect(
		await getEffectiveUsernameValidationError(
			normalizeUsername('SUPERFUCK'),
			swearEnv,
		),
	).toBe('This username is reserved.')
	expect(await isEffectivelyReservedUsername('fuck_you', swearEnv)).toBe(true)
	expect(await isEffectivelyReservedUsername('super_fuck', swearEnv)).toBe(true)
	expect(await getEffectiveUsernameValidationError('fuck_you', swearEnv)).toBe(
		usernameRequirements,
	)
	expect(
		await getEffectiveUsernameValidationError('super-fuck', swearEnv),
	).toBe('This username is reserved.')
	expect(await getEffectiveUsernameValidationError('fu-ck', swearEnv)).toBe(
		'This username is reserved.',
	)

	clearReservedUsernameSettingsCacheForTests()
	consoleWarn.mockImplementation(() => {})
	expect(
		await isEffectivelyReservedUsername(
			'faq',
			createEnv(createMemoryKv({ [reservedUsernamesKvKey]: '{not-json' })),
		),
	).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		reservedUsernamesKvReadFailedLogKey,
		expect.anything(),
	)

	clearReservedUsernameSettingsCacheForTests()
	vi.useFakeTimers()
	try {
		const memoKv = createMemoryKv({
			[reservedUsernamesKvKey]: JSON.stringify({
				added: ['brandnew'],
				removed: [],
				updatedAt: '2026-09-02T00:00:00.000Z',
				updatedBy: 'admin-stable-id',
			}),
		})
		const getSpy = vi.spyOn(memoKv, 'get')
		const memoEnv = createEnv(memoKv)
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(getSpy).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(getSpy).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	clearReservedUsernameSettingsCacheForTests()
	const setKv = createMemoryKv()
	const setEnv = createEnv(setKv)
	const added = await addReservedUsernames({
		env: setEnv,
		usernames: [' BrandNew ', 'faq'],
		updatedBy: 'admin-stable-id',
	})
	expect(added.added).toEqual(['brandnew'])
	expect(added.removed).toEqual([])
	expect(await isEffectivelyReservedUsername('brandnew', setEnv)).toBe(true)

	const restored = await addReservedUsernames({
		env: setEnv,
		usernames: ['faq'],
		updatedBy: 'admin-stable-id',
	})
	expect(restored.removed).toEqual([])

	await removeReservedUsernames({
		env: setEnv,
		usernames: ['faq'],
		updatedBy: 'admin-stable-id',
	})
	expect((await loadReservedUsernameRecord(setEnv)).removed).toEqual(['faq'])
	expect(await isEffectivelyReservedUsername('faq', setEnv)).toBe(false)

	await removeReservedUsernames({
		env: setEnv,
		usernames: ['brandnew'],
		updatedBy: 'admin-stable-id',
	})
	expect((await loadReservedUsernameRecord(setEnv)).added).toEqual([])

	await expect(
		removeReservedUsernames({
			env: setEnv,
			usernames: ['kody', 'support'],
			updatedBy: 'admin-stable-id',
		}),
	).rejects.toBeInstanceOf(PermanentlyReservedUsernameError)

	await using fixture = await createTestDb()
	const db = createPgDatabase({ connection: fixture.pg, role: 'kody_admin' })
	const conflictEmail = 'holder@example.com'
	const conflictStableId = await createStableUserIdFromEmail(conflictEmail)
	await db
		.prepare(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('brandnew', ?, ?, 'oauth_created_no_usable_password')`)
		.bind(conflictEmail, conflictStableId)
		.run()
	const collideEmail = 'collide@example.com'
	const collideStableId = await createStableUserIdFromEmail(collideEmail)
	await db
		.prepare(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('fuckyou', ?, ?, 'oauth_created_no_usable_password')`)
		.bind(collideEmail, collideStableId)
		.run()
	// Put the second conflict beyond the first 200-user page.
	await fixture.pg
		.query(`INSERT INTO users (username, email, stable_user_id, password_hash)
		SELECT 'filler-' || n, 'filler-' || n || '@example.com', 'filler-' || n, 'hash'
		FROM generate_series(1, 201) AS n`)
	const conflicts = await findReservedUsernameConflicts(
		db,
		new Set(['brandnew', 'faq', 'fuck']),
		['fuck'],
	)
	expect(conflicts).toEqual([
		{ username: 'brandnew', stableUserId: conflictStableId },
		{ username: 'fuckyou', stableUserId: collideStableId },
	])
})
