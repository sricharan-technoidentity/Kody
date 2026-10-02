import { expect, test, vi } from 'vitest'
import { createRouter } from 'remix/router'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testCookieSecret } from '#worker/test-support/auth-provider-harness.ts'
import { createUnsubscribeTipsHandler } from '#app/handlers/unsubscribe-tips.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#universal/routes.ts'
import {
	createTipsUnsubscribeToken,
	isTipsEmailsOptedOut,
	tipsUnsubscribeOneClickBody,
} from '#worker/usage/tips-unsubscribe.ts'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData, status }) =>
		Response.json({ ok: true, status: status ?? 200, loaderData }),
	),
}))

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function insertUser(store: TestDb, userId: string) {
	await store.pg.query(
		`INSERT INTO users (username, email, password_hash, stable_user_id, plan, account_type)
		 VALUES ($1, $2, 'x', $1, 'free', 'person')`,
		[userId, `${userId}@example.com`],
	)
}

/** Unsubscribe links are opened signed out: the pre-auth writer plus per-account writers. */
function createEnv(store: TestDb) {
	return {
		APP_DB: store.forUser().db,
		APP_DB_FOR_USER: (userId: string) => store.forUser(userId).db,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env
}

test('unsubscribe-tips GET applies opt-out and POST accepts RFC one-click', async () => {
	await using store = await createTestDb()
	await insertUser(store, 'user-tips')
	await insertUser(store, 'user-one-click')
	const reader = (userId: string) => store.forUser(userId).reader
	const env = createEnv(store)
	const handler = createUnsubscribeTipsHandler(env)
	const token = await createTipsUnsubscribeToken({
		env,
		userId: 'user-tips',
	})

	const missing = await handler.handler({
		request: new Request('https://example.com/unsubscribe/tips'),
		url: new URL('https://example.com/unsubscribe/tips'),
		params: {},
	} as never)
	expect(await missing.json()).toEqual({
		ok: true,
		status: 400,
		loaderData: {
			tipsUnsubscribe: {
				ok: false,
				error: 'Unsubscribe token is required.',
			},
		},
	})

	const getUrl = `https://example.com/unsubscribe/tips?token=${encodeURIComponent(token)}`
	const first = await handler.handler({
		request: new Request(getUrl),
		url: new URL(getUrl),
		params: {},
	} as never)
	expect(await first.json()).toEqual({
		ok: true,
		status: 200,
		loaderData: {
			tipsUnsubscribe: {
				ok: true,
				alreadyOptedOut: false,
				message: expect.stringContaining('unsubscribed from Kody tips'),
			},
		},
	})
	expect(
		await isTipsEmailsOptedOut({
			db: reader('user-tips'),
			userId: 'user-tips',
		}),
	).toBe(true)
	expect(
		await isTipsEmailsOptedOut({
			db: reader('user-one-click'),
			userId: 'user-one-click',
		}),
	).toBe(false)

	vi.mocked(renderAppPage).mockClear()
	const again = await handler.handler({
		request: new Request(getUrl),
		url: new URL(getUrl),
		params: {},
	} as never)
	expect(await again.json()).toMatchObject({
		loaderData: {
			tipsUnsubscribe: { ok: true, alreadyOptedOut: true },
		},
	})

	const otherHandler = createUnsubscribeTipsHandler(env)
	const postToken = await createTipsUnsubscribeToken({
		env,
		userId: 'user-one-click',
	})
	const postUrl = `https://example.com/unsubscribe/tips?token=${encodeURIComponent(postToken)}`
	const posted = await otherHandler.handler({
		request: new Request(postUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: tipsUnsubscribeOneClickBody,
		}),
		url: new URL(postUrl),
		params: {},
	} as never)
	expect(posted.status).toBe(200)
	expect(await posted.text()).toContain('unsubscribed from Kody tips')
	expect(
		await isTipsEmailsOptedOut({
			db: reader('user-one-click'),
			userId: 'user-one-click',
		}),
	).toBe(true)
})

test('string-literal unsubscribeTips route accepts RFC one-click POST', async () => {
	let method = ''
	const router = createRouter()
	router.map(
		{ unsubscribeTips: routes.unsubscribeTips },
		{
			actions: {
				unsubscribeTips: {
					middleware: [],
					async handler({ request }) {
						method = request.method
						return new Response('posted')
					},
				},
			},
		},
	)
	const posted = await router.fetch(
		new Request('http://localhost/unsubscribe/tips?token=x', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: tipsUnsubscribeOneClickBody,
		}),
	)
	expect(posted.status).toBe(200)
	expect(await posted.text()).toBe('posted')
	expect(method).toBe('POST')
})
