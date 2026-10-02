import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { parseSiteBannerInput } from '#universal/site-banners.ts'
import {
	deleteSiteBanner,
	dismissSiteBannerForUser,
	listDismissedBannerIds,
	listEnabledSiteBanners,
	listSiteBannersForAdmin,
	saveSiteBanner,
} from './service.ts'

function launchInput(overrides: Record<string, unknown> = {}) {
	const parsed = parseSiteBannerInput({
		enabled: true,
		priority: 20,
		title: 'Kody is live',
		body: 'Watch the launch video.',
		ctaHref: 'https://example.com/kody-launch-video',
		ctaLabel: 'Watch the video',
		secondaryHref: '/blog',
		secondaryLabel: 'Read the announcement',
		severity: 'promo',
		look: 'promo',
		icon: 'play',
		pageTargeting: 'all',
		audience: 'everyone',
		dismissible: true,
		...overrides,
	})
	if (!parsed.ok) throw new Error(parsed.error)
	return parsed.value
}

test('site banner service: save, list enabled vs admin, dismiss, delete', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	await database.pg
		.query(`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (1, 'alice', 'alice@example.com', 'alice', 'x'), (2, 'bob', 'bob@example.com', 'bob', 'x')`)
	const admin = createPgDatabase({
		connection: database.pg,
		role: 'kody_admin',
		userId: 'alice',
	})
	const { db, reader } = database
	const userId = 1

	const saved = await saveSiteBanner(admin, {
		banner: launchInput(),
		actorUserId: userId,
	})
	expect(saved.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	)
	expect(saved.look).toBe('promo')
	expect(saved.enabled).toBe(true)

	await saveSiteBanner(admin, {
		banner: launchInput({
			enabled: false,
			priority: 50,
			title: 'Disabled winner',
			look: 'card',
		}),
		actorUserId: userId,
	})

	const enabled = await listEnabledSiteBanners(reader)
	expect(enabled.map((banner) => banner.title)).toEqual(['Kody is live'])

	const adminList = await listSiteBannersForAdmin(admin)
	expect(adminList.map((banner) => banner.title)).toEqual([
		'Disabled winner',
		'Kody is live',
	])

	await expect(
		saveSiteBanner(db, { banner: launchInput(), actorUserId: userId }),
	).rejects.toThrow('permission denied')
	await dismissSiteBannerForUser(database.forUser('bob').db, {
		bannerId: saved.id,
		userId: 2,
	})
	await expect(
		dismissSiteBannerForUser(db, { bannerId: saved.id, userId: 2 }),
	).rejects.toThrow('row-level security')
	expect(await listDismissedBannerIds(reader, 2)).toEqual([])
	await dismissSiteBannerForUser(db, { bannerId: saved.id, userId })
	await dismissSiteBannerForUser(db, { bannerId: saved.id, userId })
	expect(await listDismissedBannerIds(db, userId)).toEqual([saved.id])

	expect(await deleteSiteBanner(admin, saved.id)).toBe(true)
	expect(await listDismissedBannerIds(db, userId)).toEqual([])
	expect(
		await listDismissedBannerIds(database.forUser('bob').reader, 2),
	).toEqual([])
	expect(await deleteSiteBanner(admin, saved.id)).toBe(false)
})
