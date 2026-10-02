import { expect, test, vi } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	stampFirstExecute,
	stampFirstIntegration,
	stampFirstJob,
	stampFirstSecret,
	touchLastActiveAt,
	userHasFirstExecute,
	userHasFirstSearch,
	stampFirstMcpConnected,
	stampFirstSavedPackage,
	stampFirstSearch,
} from './activation-stamps.ts'

test('activation stamps are write-once and keep the first client name', async () => {
	const userId = 'a'.repeat(64)
	await using store = await createTestDb({ userId })
	await store.pg.exec("SET TIME ZONE 'Asia/Kolkata'")
	await store.pg.query(
		`INSERT INTO users (username, email, stable_user_id, password_hash)
		 VALUES ('alice', 'alice@example.test', $1, 'x')`,
		[userId],
	)

	await stampFirstMcpConnected(store.db, {
		stableUserId: userId,
		clientName: 'claude-ai',
		at: '2026-08-27T10:00:00.000Z',
	})
	await stampFirstMcpConnected(store.db, {
		stableUserId: userId,
		clientName: 'cursor',
		at: '2026-08-28T10:00:00.000Z',
	})
	await stampFirstExecute(store.db, {
		stableUserId: userId,
		at: '2026-08-27T11:00:00.000Z',
	})
	await stampFirstExecute(store.db, {
		stableUserId: userId,
		at: '2026-08-28T11:00:00.000Z',
	})
	await stampFirstSearch(store.db, {
		stableUserId: userId,
		at: '2026-08-27T11:30:00.000Z',
	})
	await stampFirstSearch(store.db, {
		stableUserId: userId,
		at: '2026-08-28T11:30:00.000Z',
	})
	await stampFirstSavedPackage(store.db, {
		stableUserId: userId,
		at: '2026-08-27T12:00:00.000Z',
	})
	await stampFirstSavedPackage(store.db, {
		stableUserId: userId,
		at: '2026-08-28T12:00:00.000Z',
	})

	expect(
		await store.reader
			.prepare(`SELECT first_mcp_connected_at, mcp_client_name,
		first_execute_at, first_search_at, first_saved_package_at, first_secret_at,
		first_integration_at, first_job_at, last_active_at FROM users`)
			.first(),
	).toEqual({
		first_mcp_connected_at: '2026-08-27T10:00:00.000Z',
		mcp_client_name: 'claude-ai',
		first_execute_at: '2026-08-27T11:00:00.000Z',
		first_search_at: '2026-08-27T11:30:00.000Z',
		first_saved_package_at: '2026-08-27T12:00:00.000Z',
		first_secret_at: null,
		first_integration_at: null,
		first_job_at: null,
		last_active_at: '2026-08-28T10:00:00.000Z',
	})
})

test('all activation claims emit once, track UTC days and cannot update another account', async () => {
	const userId = 'a'.repeat(64)
	await using store = await createTestDb({ userId })
	await store.pg.exec("SET TIME ZONE 'Asia/Kolkata'")
	await store.pg.query(
		`INSERT INTO users (username, email, stable_user_id, password_hash)
		 VALUES ('alice', 'alice@example.test', $1, 'x'), ('bob', 'bob@example.test', 'bob', 'x')`,
		[userId],
	)
	const writeDataPoint = vi.fn()
	const telemetry = { ONBOARDING_FUNNEL_EVENTS: { writeDataPoint } }
	expect(await userHasFirstExecute(store.reader, userId)).toBe(false)
	expect(await userHasFirstSearch(store.reader, userId)).toBe(false)
	expect(
		await stampFirstExecute(store.reader, { stableUserId: userId }, telemetry),
	).toBe(false)
	for (const stamp of [
		stampFirstExecute,
		stampFirstSearch,
		stampFirstSavedPackage,
		stampFirstSecret,
		stampFirstIntegration,
		stampFirstJob,
	]) {
		expect(
			await stamp(
				store.db,
				{
					stableUserId: userId,
					at: '2026-08-27T12:00:00.000Z',
				},
				telemetry,
			),
		).toBe(true)
		expect(
			await stamp(
				store.db,
				{
					stableUserId: userId,
					at: '2026-08-28T12:00:00.000Z',
				},
				telemetry,
			),
		).toBe(false)
	}
	expect(writeDataPoint).toHaveBeenCalledTimes(6)
	expect(
		await store.reader
			.prepare(
				`SELECT first_secret_at, first_integration_at, first_job_at FROM users`,
			)
			.first(),
	).toEqual({
		first_secret_at: '2026-08-27T12:00:00.000Z',
		first_integration_at: '2026-08-27T12:00:00.000Z',
		first_job_at: '2026-08-27T12:00:00.000Z',
	})
	expect(await userHasFirstExecute(store.reader, userId)).toBe(true)
	expect(await userHasFirstSearch(store.reader, userId)).toBe(true)
	const updatedAt = await store.reader
		.prepare('SELECT updated_at FROM users')
		.first('updated_at')
	await touchLastActiveAt(store.db, {
		stableUserId: userId,
		at: '2026-08-28T23:00:00.000Z',
	})
	expect(
		await store.reader
			.prepare('SELECT updated_at FROM users')
			.first('updated_at'),
	).toBe(updatedAt)
	await touchLastActiveAt(store.db, {
		stableUserId: userId,
		at: '2026-08-29T00:30:00+02:00',
	})
	expect(
		await store.reader
			.prepare('SELECT last_active_at FROM users')
			.first('last_active_at'),
	).toBe('2026-08-28T12:00:00.000Z')
	await touchLastActiveAt(store.db, {
		stableUserId: userId,
		at: '2026-08-29T00:01:00.000Z',
	})
	expect(
		await store.reader
			.prepare('SELECT last_active_at FROM users')
			.first('last_active_at'),
	).toBe('2026-08-29T00:01:00.000Z')
	await stampFirstExecute(store.db, { stableUserId: 'bob' }, telemetry)
	await stampFirstMcpConnected(store.db, {
		stableUserId: 'bob',
		clientName: 'cursor',
	})
	expect(
		await store
			.forUser('bob')
			.reader.prepare(
				'SELECT first_execute_at, first_mcp_connected_at, last_active_at FROM users',
			)
			.first(),
	).toEqual({
		first_execute_at: null,
		first_mcp_connected_at: null,
		last_active_at: null,
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(6)
})
