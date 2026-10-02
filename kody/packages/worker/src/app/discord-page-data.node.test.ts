import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { loadDiscordPageData } from '#app/discord-page-data.ts'
import { createDiscordApiHandler } from '#app/handlers/discord.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAppEnv(
	db: PgDatabase,
	overrides: Record<string, string> = {},
): Env {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
		...overrides,
	} as unknown as Env
}

async function seedUser(
	store: Awaited<ReturnType<typeof createTestDb>>,
	input: { id: number; email: string },
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		 VALUES ($1, $2, $3, $4, 'x')`,
		[input.id, `user-${input.id}`, input.email, stableUserId],
	)
	return stableUserId
}

test('discord page reports guest, unconnected, and connected states', async () => {
	setAuthSessionSecret(testCookieSecret)
	const memberId = await createStableUserIdFromEmail('member@example.com')
	await using store = await createTestDb({ userId: memberId })
	const db = store.db
	const env = createAppEnv(db)
	const handler = createDiscordApiHandler(env)

	const anonymous = await handler.handler({
		request: new Request('http://example.com/discord.json'),
		url: new URL('http://example.com/discord.json'),
		params: {},
	} as never)
	expect(await anonymous.json()).toEqual({
		ok: true,
		signedIn: false,
		discordConnected: false,
		discordDisplayName: null,
		discordProviderAvailable: true,
		canSyncDiscordRoles: false,
		inviteUrl: kodyDiscordInviteUrl,
		turnstileSiteKey: null,
	})

	const stableUserId = await seedUser(store, {
		id: 7,
		email: 'member@example.com',
	})
	await seedUser(store, { id: 8, email: 'other@example.com' })
	expect(
		await loadDiscordPageData({
			env,
			userId: 7,
		}),
	).toEqual({
		ok: true,
		signedIn: true,
		discordConnected: false,
		discordDisplayName: null,
		discordProviderAvailable: true,
		canSyncDiscordRoles: false,
		inviteUrl: kodyDiscordInviteUrl,
		turnstileSiteKey: null,
	})

	await store.pg.query(
		`INSERT INTO oauth_connections (
			provider_name, provider_id, user_id, provider_display_name
		) VALUES ('discord', '333333333333333333', 7, 'Kody Fan'),
		         ('discord', '444444444444444444', 8, 'Someone Else')`,
	)
	// Another account's link is outside the member's RLS scope.
	expect(await loadDiscordPageData({ env, userId: 8 })).toMatchObject({
		discordConnected: false,
		discordDisplayName: null,
	})

	expect(
		await loadDiscordPageData({
			env,
			userId: 7,
		}),
	).toMatchObject({
		signedIn: true,
		discordConnected: true,
		discordDisplayName: 'Kody Fan',
		canSyncDiscordRoles: false,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				DISCORD_BOT_TOKEN: 'bot-token-test',
				DISCORD_GUILD_ID: '111111111111111111',
				DISCORD_MEMBER_ROLE_ID: '222222222222222222',
			}),
			userId: 7,
		}),
	).toMatchObject({
		discordConnected: true,
		canSyncDiscordRoles: true,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				DISCORD_CLIENT_ID: '',
				DISCORD_CLIENT_SECRET: '',
			}),
			userId: 7,
		}),
	).toMatchObject({
		discordProviderAvailable: false,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
				TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
			}),
			userId: 7,
		}),
	).toMatchObject({
		turnstileSiteKey: '1x00000000000000000000AA',
	})

	const sessionCookie = await createAuthCookie(
		{
			stableUserId,
			email: 'member@example.com',
			rememberMe: false,
		},
		false,
	)
	const signedIn = await handler.handler({
		request: new Request('http://example.com/discord.json', {
			headers: { Cookie: sessionCookie.split(';')[0] ?? sessionCookie },
		}),
		url: new URL('http://example.com/discord.json'),
		params: {},
	} as never)
	expect(await signedIn.json()).toMatchObject({
		ok: true,
		signedIn: true,
		discordConnected: true,
		discordDisplayName: 'Kody Fan',
	})
})
