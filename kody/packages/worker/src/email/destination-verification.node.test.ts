import { createTestPg } from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { hashVerificationToken } from '#worker/identity/email-verification-tokens.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	addEmailNotificationDestination,
	type EmailDestinationError,
} from './destinations.ts'
import {
	createEmailDestinationVerification,
	emailDestinationRateLimitConfig,
	verifyEmailDestinationToken,
} from './destination-verification.ts'

async function createMigratedDb() {
	const sqlite = await createTestPg()

	return {
		sqlite,
		db: createPgDatabase({
			connection: sqlite,
			role: 'kody_writer',
			userId: await createStableUserIdFromEmail('owner@example.com'),
		}),
	}
}

async function seedUser(sqlite: Awaited<ReturnType<typeof createTestPg>>) {
	const stableUserId = await createStableUserIdFromEmail('owner@example.com')
	await sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1,
			'owner',
			'owner@example.com',
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			CURRENT_TIMESTAMP
		);
	`)
}

test('destination verification tokens mark one extra address verified and reject missing/expired links', async () => {
	const { sqlite, db } = await createMigratedDb()
	await seedUser(sqlite)
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'phone@example.com',
	})

	expect(await verifyEmailDestinationToken({ db, token: '' })).toEqual({
		ok: false,
		reason: 'missing_token',
	})
	expect(await verifyEmailDestinationToken({ db, token: 'nope' })).toEqual({
		ok: false,
		reason: 'invalid_token',
	})

	const token = 'a'.repeat(64)
	const tokenHash = await hashVerificationToken(token)
	await pgQuery(sqlite).run(
		`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (1, ?, ?, ?)`,
		added.destination.id,
		tokenHash,
		Date.now() - 1,
	)
	expect(await verifyEmailDestinationToken({ db, token })).toEqual({
		ok: false,
		reason: 'expired_token',
	})

	const liveToken = 'b'.repeat(64)
	const liveHash = await hashVerificationToken(liveToken)
	await pgQuery(sqlite).run(
		`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (1, ?, ?, ?)`,
		added.destination.id,
		liveHash,
		Date.now() + 60_000,
	)

	expect(
		await verifyEmailDestinationToken({
			db,
			token: liveToken,
			consume: false,
		}),
	).toEqual({
		ok: true,
		userId: 1,
		email: 'phone@example.com',
	})
	expect(
		(await pgQuery(sqlite).get(
			`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations
				 WHERE id = ?`,
			added.destination.id,
		)) as { verified: boolean },
	).toEqual({ verified: false })

	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual({
		ok: true,
		userId: 1,
		email: 'phone@example.com',
	})
	expect(
		(await pgQuery(sqlite).get(
			`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations
				 WHERE id = ?`,
			added.destination.id,
		)) as { verified: boolean },
	).toEqual({ verified: true })
	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual({
		ok: true,
		userId: 1,
		email: 'phone@example.com',
	})
	expect(
		(await pgQuery(sqlite).get(
			`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
		)) as { count: number },
	).toEqual({ count: 1 })
})

test('createEmailDestinationVerification rate-limits add and resend for UI and MCP', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = await createMigratedDb()
	await seedUser(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as Env

	for (
		let index = 0;
		index < emailDestinationRateLimitConfig.maxRequests;
		index++
	) {
		const added = await createEmailDestinationVerification({
			env,
			userId: 1,
			email: `extra-${index}@example.com`,
			requestUrl: 'http://example.com',
		})
		expect(added.created).toBe(true)
	}

	await expect(
		createEmailDestinationVerification({
			env,
			userId: 1,
			email: 'one-more@example.com',
			requestUrl: 'http://example.com',
		}),
	).rejects.toMatchObject({
		code: 'rate_limited',
	} satisfies Partial<EmailDestinationError>)
	expect(consoleWarn).toHaveBeenCalled()
})

test('createEmailDestinationVerification resends for a pending address and leaves unused links valid', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = await createMigratedDb()
	await seedUser(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as Env

	const first = await createEmailDestinationVerification({
		env,
		userId: 1,
		email: 'pager@example.com',
		requestUrl: 'http://example.com',
	})
	expect(first.created).toBe(true)
	const firstToken = (await pgQuery(sqlite).get(
		`SELECT token_hash AS "tokenHash"
			 FROM pending_email_destination_verifications
			 WHERE destination_id = ?`,
		first.destination.id,
	)) as { tokenHash: string }

	const second = await createEmailDestinationVerification({
		env,
		userId: 1,
		email: 'Pager@Example.com',
		requestUrl: 'http://example.com',
	})
	expect(second).toMatchObject({
		created: false,
		destination: { id: first.destination.id, email: 'pager@example.com' },
	})
	const pending = (await pgQuery(sqlite).all(
		`SELECT token_hash AS "tokenHash"
			 FROM pending_email_destination_verifications
			 WHERE destination_id = ?
			 ORDER BY id ASC`,
		first.destination.id,
	)) as Array<{ tokenHash: string }>
	expect(pending).toHaveLength(2)
	expect(pending[0]?.tokenHash).toBe(firstToken.tokenHash)
	expect(pending[1]?.tokenHash).not.toBe(firstToken.tokenHash)
})
