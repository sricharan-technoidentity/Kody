import { expect } from 'vitest'
import { createAuthProviderStartHandler } from '#app/handlers/auth-provider.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

export const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

export type Handler = {
	handler(context: never): Promise<Response>
}

/**
 * PGlite with the application schema. `sql` runs superuser fixture queries
 * (`?` placeholders) that bypass RLS, for seeding and assertions only.
 */
export async function createMigratedDb() {
	const store = await createTestDb()
	async function rows(query: string, params: Array<unknown>) {
		let index = 0
		const result = await store.pg.query<Record<string, unknown>>(
			query.replace(/\?/g, () => `$${++index}`),
			params,
		)
		return result.rows
	}
	return {
		...store,
		sql: {
			get: async (query: string, ...params: Array<unknown>) =>
				(await rows(query, params))[0],
			all: (query: string, ...params: Array<unknown>) => rows(query, params),
			exec: (script: string) => store.pg.exec(script),
		},
	}
}

export type AuthTestDb = Awaited<ReturnType<typeof createMigratedDb>>

export async function seedUser(
	store: AuthTestDb,
	input: {
		id: number
		email: string
		username: string
		stableUserId?: string
		emailVerified?: boolean
	},
) {
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			input.id,
			input.username,
			input.email,
			input.stableUserId ?? (await createStableUserIdFromEmail(input.email)),
			await createPasswordHash('test-password'),
			input.emailVerified ? new Date().toISOString() : null,
		],
	)
	// Explicit ids leave the identity sequence behind; later signups must not collide.
	await store.pg.query(
		`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users))`,
	)
}

/**
 * A request environment: `APP_DB` is the pre-auth writer (no account context)
 * unless `sessionUserId` names the signed-in account, and `APP_DB_FOR_USER`
 * hands out each account's writer once a definer names it. `wrapAccountDb`
 * lets tests inject races into those per-account writers.
 */
export function createAppEnv(
	store: AuthTestDb,
	overrides: Record<string, unknown> = {},
	options: {
		sessionUserId?: string
		wrapAccountDb?: (db: PgDatabase) => PgDatabase
	} = {},
): Env {
	const wrap = options.wrapAccountDb ?? ((db: PgDatabase) => db)
	return {
		APP_DB: options.sessionUserId
			? wrap(store.forUser(options.sessionUserId).db)
			: store.db,
		APP_DB_FOR_USER: (stableUserId: string) =>
			wrap(store.forUser(stableUserId).db),
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		GITHUB_CLIENT_ID: 'github-client-id-test',
		GITHUB_CLIENT_SECRET: 'github-client-secret-test',
		GOOGLE_CLIENT_ID: 'google-client-id-test',
		GOOGLE_CLIENT_SECRET: 'google-client-secret-test',
		X_CLIENT_ID: 'x-client-id-test',
		X_CLIENT_SECRET: 'x-client-secret-test',
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
		...overrides,
	} as unknown as Env
}

export function createMemoryKv(initial?: Record<string, string>) {
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
		store,
	} as unknown as KVNamespace
}

export async function runHandler(
	handler: Handler,
	request: Request,
	params: Record<string, string> = {},
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params,
	} as never)
}

export function getCookiePair(setCookieHeader: string) {
	const pair = setCookieHeader.split(';')[0]
	if (!pair) throw new Error(`Unexpected Set-Cookie header: ${setCookieHeader}`)
	return pair
}

export async function startProviderFlow(
	env: Env,
	provider: string,
	url: string,
) {
	const startResponse = await runHandler(
		createAuthProviderStartHandler(env),
		new Request(url, { method: 'POST' }),
		{ provider },
	)
	expect(startResponse.status).toBe(302)
	const location = startResponse.headers.get('Location') ?? ''
	const stateCookie = getCookiePair(
		startResponse.headers.get('Set-Cookie') ?? '',
	)
	const state = new URL(location).searchParams.get('state') ?? ''
	return { location, stateCookie, state }
}
