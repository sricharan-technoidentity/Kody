import { env } from '#worker/test-support/runner-suite.ts'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	createInMemoryUserMeterEnv,
	createWaitUntilDrain,
} from '#worker/test-support/user-meter.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

async function seedOutboundFetchCounter(userId: string, count: number) {
	Object.assign(env, createInMemoryUserMeterEnv().env)
	await env.USER_METERS!.forUser(userId).initialize({
		resource: 'outbound_fetches_per_day',
		day: utcDayKey(),
		count,
		updatedAt: new Date().toISOString(),
	})
}

test('gateway fetches consume the daily outbound-fetch entitlement and deny over the plan limit', async () => {
	silenceIncidentalRuntimeWarnings()
	const email = `fetcher-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `fetcher-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'free',
		stableUserId: userId,
	})
	const props = {
		baseUrl: 'https://kody.example.com',
		userId,
		email,
		storageContext: null,
	}
	const globalFetch = (async () =>
		new Response('ok')) as unknown as typeof fetch
	const drain = createWaitUntilDrain()

	const allowed = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	})
	expect(await allowed.text()).toBe('ok')
	await drain.drain()
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'outbound_fetches_per_day',
			day: utcDayKey(),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })

	// Fill the remaining free-plan quota in UserMeter, then expect denial.
	await seedOutboundFetchCounter(
		userId,
		planLimits.free.maxOutboundFetchesPerDay,
	)
	const denied = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(denied)).toBe(true)

	// Callers that carry no email (MCP provider requests, package
	// runtime) still bind to the caller's real plan: the gateway
	// reverse-resolves the account from the stable userId instead of
	// failing open to the `max` quota.
	const deniedWithoutEmail = await executeGatewayFetch({
		env,
		props: { ...props, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(deniedWithoutEmail)).toBe(true)

	// Contextless fetches (no userId) are not metered against a user and
	// pass through without consuming any counter.
	const contextless = await executeGatewayFetch({
		env,
		props: { ...props, userId: null, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	})
	expect(await contextless.text()).toBe('ok')
	await drain.drain()
}, 30_000)
