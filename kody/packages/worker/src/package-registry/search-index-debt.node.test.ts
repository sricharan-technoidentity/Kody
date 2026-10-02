import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const mockModule = vi.hoisted(() => ({
	upsertSavedPackageVector: vi.fn(),
	captureException: vi.fn(),
}))

vi.mock('./vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
}))

import { scheduleSavedPackageSearchIndexUpsert } from './search-index-debt.ts'

/** Debt rows are written through the owner's scoped writer and read back as schema owner. */
async function createDebtDb() {
	const store = await createTestDb()
	async function row(packageId: string) {
		const result = await store.pg.query<{
			packageId: string
			userId: string
			generation: number
			embedText: string
			lastError: string | null
		}>(
			`SELECT package_id AS "packageId", user_id AS "userId", generation::int AS generation,
				embed_text AS "embedText", last_error AS "lastError"
			FROM saved_package_search_index_debt WHERE package_id = $1`,
			[packageId],
		)
		return result.rows[0]
	}
	return {
		...store,
		row,
		envFor: (userId: string) =>
			({ APP_DB: store.forUser(userId).db }) as unknown as Env,
	}
}

test('scheduleSavedPackageSearchIndexUpsert defers via waitUntil and clears debt on success', async () => {
	let resolveUpsert: (() => void) | undefined
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.upsertSavedPackageVector.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				resolveUpsert = resolve
			}),
	)
	await using debt = await createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	const schedulePromise = scheduleSavedPackageSearchIndexUpsert({
		env: debt.envFor('user-1'),
		packageId: 'pkg-1',
		userId: 'user-1',
		embedText: 'hello',
		waitUntil: (promise) => {
			waitUntilPromises.push(promise)
		},
	})
	await schedulePromise
	expect(await debt.row('pkg-1')).toBeDefined()
	expect(waitUntilPromises).toHaveLength(1)
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
			expect.anything(),
			{
				packageId: 'pkg-1',
				userId: 'user-1',
				embedText: 'hello',
			},
		)
	})
	resolveUpsert?.()
	await waitUntilPromises[0]
	expect(await debt.row('pkg-1')).toBeUndefined()
})

test('scheduleSavedPackageSearchIndexUpsert keeps debt and reports to Sentry on failure', async () => {
	consoleError.mockImplementation(() => {})
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.captureException.mockReset()
	mockModule.upsertSavedPackageVector.mockRejectedValue(
		new Error('vectorize down'),
	)
	await using debt = await createDebtDb()
	await scheduleSavedPackageSearchIndexUpsert({
		env: debt.envFor('user-2'),
		packageId: 'pkg-2',
		userId: 'user-2',
		embedText: 'hello',
	})
	expect(await debt.row('pkg-2')).toMatchObject({
		packageId: 'pkg-2',
		userId: 'user-2',
		generation: 1,
		lastError: 'vectorize down',
	})
	expect(mockModule.captureException).toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
})

test('out-of-order publishes keep the newest embed text under one coalesced reconcile', async () => {
	let resolveFirstUpsert: (() => void) | undefined
	let upsertCalls = 0
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.upsertSavedPackageVector.mockImplementation(async () => {
		upsertCalls += 1
		if (upsertCalls === 1) {
			await new Promise<void>((resolve) => {
				resolveFirstUpsert = resolve
			})
		}
	})
	await using debt = await createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		waitUntilPromises.push(promise)
	}

	await scheduleSavedPackageSearchIndexUpsert({
		env: debt.envFor('user-a'),
		packageId: 'pkg-race',
		userId: 'user-a',
		embedText: 'older',
		waitUntil,
	})
	// Another account cannot take over the owner's debt row.
	await expect(
		scheduleSavedPackageSearchIndexUpsert({
			env: debt.envFor('user-b'),
			packageId: 'pkg-race',
			userId: 'user-b',
			embedText: 'hijack',
		}),
	).rejects.toThrow(/row-level security/)
	await scheduleSavedPackageSearchIndexUpsert({
		env: debt.envFor('user-a'),
		packageId: 'pkg-race',
		userId: 'user-a',
		embedText: 'newer',
		waitUntil,
	})
	expect(await debt.row('pkg-race')).toMatchObject({
		generation: 2,
		userId: 'user-a',
		embedText: 'newer',
	})
	// Coalesced to one in-flight reconcile.
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(1)
	})
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({ userId: 'user-a', embedText: 'older' }),
	)

	resolveFirstUpsert?.()
	await waitUntilPromises[0]
	await waitUntilPromises[1]

	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({ userId: 'user-a', embedText: 'newer' }),
	)
	expect(await debt.row('pkg-race')).toBeUndefined()
})
