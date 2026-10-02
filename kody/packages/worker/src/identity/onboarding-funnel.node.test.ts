import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	foldOnboardingFunnelRows,
	onboardingFunnelCountQuery,
	recordCheckoutFunnelEvent,
	recordMcpConnectFunnelEvent,
	recordOnboardingFunnelEvent,
	resolveOnboardingFunnelDataset,
} from './onboarding-funnel.ts'
import { stampFirstSearch } from './activation-stamps.ts'

const userId = 'a'.repeat(64)

test('funnel points omit prompts, secrets, and non-stable ids', () => {
	const writeDataPoint = vi.fn()
	const env = {
		ONBOARDING_FUNNEL_EVENTS: { writeDataPoint },
	}
	recordOnboardingFunnelEvent(env, {
		stage: 'signup_completed',
		userId,
	})
	recordOnboardingFunnelEvent(env, {
		stage: 'signup_completed',
		userId: 'ada@example.com',
	})
	recordMcpConnectFunnelEvent(env, {
		stage: 'mcp_connect_failed',
		userId,
		clientId: 'https://cursor.com/oauth?code=secret-value',
		clientName: 'Cursor',
		errorClass: 'please retry with password hunter2',
	})
	recordCheckoutFunnelEvent(env, {
		stage: 'checkout_started',
		userId,
		plan: 'pro',
	})
	recordCheckoutFunnelEvent(env, {
		stage: 'checkout_started',
		userId,
		plan: 'secret-plan',
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(3)
	expect(writeDataPoint).toHaveBeenNthCalledWith(1, {
		indexes: [userId],
		blobs: ['signup_completed', '', '', ''],
		doubles: [1],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(2, {
		indexes: [userId],
		blobs: ['mcp_connect_failed', 'cursor', 'other', 'cursor.com'],
		doubles: [1],
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('hunter2')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('secret')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('ada@')
	consoleWarn.mockImplementation(() => {})
	writeDataPoint.mockImplementation(() => {
		throw new Error('analytics down')
	})
	expect(() =>
		recordOnboardingFunnelEvent(env, {
			stage: 'email_verified',
			userId,
		}),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledWith(
		'onboarding-funnel-event-failed',
		expect.any(Error),
	)
})

test('first search emits once even when the stamp is repeated', async () => {
	const writeDataPoint = vi.fn()
	await using database = await createTestDb({ userId })
	await database.pg.query(
		`INSERT INTO users (username, email, stable_user_id, password_hash)
		 VALUES ('alice', 'alice@example.test', $1, 'x')`,
		[userId],
	)
	const db = database.db
	const env = { ONBOARDING_FUNNEL_EVENTS: { writeDataPoint } }
	expect(
		await Promise.all([
			stampFirstSearch(db, { stableUserId: userId }, env),
			stampFirstSearch(db, { stableUserId: userId }, env),
		]),
	).toEqual([true, false])
	expect(await stampFirstSearch(db, { stableUserId: userId }, env)).toBe(false)
	expect(writeDataPoint).toHaveBeenCalledOnce()
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: ['first_search', '', '', ''],
	})
})

test('funnel SQL groups distinct users and missing stages stay zero', () => {
	expect(resolveOnboardingFunnelDataset({})).toBe(
		'kody_onboarding_funnel_events',
	)
	expect(
		resolveOnboardingFunnelDataset({ SENTRY_ENVIRONMENT: 'preview' }),
	).toBe('kody_onboarding_funnel_events_preview')
	const query = onboardingFunnelCountQuery({
		dataset: 'kody_onboarding_funnel_events',
		days: 7,
	})
	expect(query).toContain('count(DISTINCT index1)')
	expect(query).toContain("'first_package'")
	expect(query).toContain("'email_verified'")
	const window = foldOnboardingFunnelRows(7, [
		{ stage: 'signup_completed', users: '4' },
		{ stage: 'not_a_stage', users: 9 },
		{ stage: 'first_search', users: 1 },
	])
	expect(
		window.steps.find((step) => step.stage === 'signup_completed'),
	).toEqual({ stage: 'signup_completed', users: 4 })
	expect(window.steps.find((step) => step.stage === 'first_job')).toEqual({
		stage: 'first_job',
		users: 0,
	})
})
