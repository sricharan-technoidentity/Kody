import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
vi.unmock('#worker/audit-log.ts')

import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createPgDatabase, type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createTestAuditDb } from '#worker/test-support/aws/test-audit-db.ts'
import {
	createJobsBindingStub,
	createSuccessfulDeletionEnv,
} from '#worker/test-support/account-deletion.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import * as AuditLog from '#worker/audit-log.ts'
import * as AccountDeletion from '#app/account-deletion.ts'
import * as DeletionState from '#worker/account/deletion-state.ts'
import { AccountDeletionWritersActiveError } from '#worker/account/deletion-state.ts'
import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	type AccountDeletionResult,
} from '#app/account-deletion.ts'
import {
	listUnverifiedAccountPurgeCandidates,
	pruneUnverifiedAccounts,
	unverifiedAccountPurgeFailureReasonMaxLength,
} from './unverified-account-purge.ts'

const now = new Date('2026-09-02T12:00:00.000Z')
const millisecondsPerDay = 24 * 60 * 60 * 1000

function daysAgo(days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function minutesAgo(minutes: number) {
	return new Date(now.getTime() - minutes * 60 * 1000).toISOString()
}

type AppDb = Awaited<ReturnType<typeof createAppDb>>
type AuditDb = Awaited<ReturnType<typeof createTestAuditDb>>

async function deletingAt(app: AppDb, username: string) {
	const { rows } = await app.pg.query<{ deleting_at: string | null }>(
		`SELECT deleting_at FROM users WHERE username = $1`,
		[username],
	)
	return rows[0]?.deleting_at ?? null
}

function withVerifyAfterUnverifiedAccountSelect(
	db: PgDatabase,
	verifiedAt: string,
): PgDatabase {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			if (!query.includes('SELECT id, stable_user_id, email, created_at')) {
				return statement
			}
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async all<T>() {
							const result = await bound.all<T & { id: number }>()
							for (const row of result.results) {
								await originalPrepare(
									`UPDATE users SET email_verified_at = ? WHERE id = ?`,
								)
									.bind(verifiedAt, row.id)
									.run()
							}
							return result
						},
					}
				},
			}
		},
	}
}

function emptyDeletionResult(): AccountDeletionResult {
	return {
		deletedRowCounts: {},
		updatedRowCounts: {},
		deletedKvKeys: 0,
		deletedCommunityAssets: 0,
		deletedEmailBlobs: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects: {},
		deletedVectors: 0,
		warnings: ['simulated cleanup'],
	}
}

function emailHash(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/**
 * The purge lists, claims and releases through kody_admin; each account is
 * deleted through that subject's kody_subject_purger (jobs through its writer).
 */
async function createAppDb() {
	const database = await createTestDb()
	const purgers = new Map<string, PgDatabase>()
	return {
		pg: database.pg,
		db: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
		purgerFor(stableUserId: string) {
			let purger = purgers.get(stableUserId)
			if (!purger) {
				purger = createPgDatabase({
					connection: database.pg,
					role: 'kody_subject_purger',
					userId: stableUserId,
				})
				purgers.set(stableUserId, purger)
			}
			return purger
		},
		writerFor: (stableUserId: string) => database.forUser(stableUserId).db,
		[Symbol.asyncDispose]: () => database.pg.close(),
	}
}

function createPurgeEnv(app: AppDb, auditDb: PgDatabase, db = app.db) {
	const env = {
		...createSuccessfulDeletionEnv(db as unknown as SqlDatabase),
		AUDIT_DB: auditDb,
	} as unknown as Env
	return {
		env,
		subjectEnv: (stableUserId: string) =>
			({
				...env,
				APP_DB: app.purgerFor(stableUserId),
				JOBS: createJobsBindingStub(
					app.writerFor(stableUserId) as unknown as SqlDatabase,
				),
			}) as unknown as Env,
	}
}

async function seedUser(
	app: AppDb,
	input: {
		username: string
		email: string
		createdAt: string
		emailVerifiedAt?: string | null
		accountType?: 'person' | 'platform'
		deletingAt?: string | null
		oauthProvider?: string
	},
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	const { rows } = await app.pg.query<{ id: number }>(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id,
			email_verified_at, account_type, deleting_at, created_at
		) VALUES ($1, $2, 'hash', $3, $4, $5, $6, $7)
		RETURNING id::int AS id`,
		[
			input.username,
			input.email,
			stableUserId,
			input.emailVerifiedAt ?? null,
			input.accountType ?? 'person',
			input.deletingAt ?? null,
			input.createdAt,
		],
	)
	const id = rows[0]!.id
	if (input.oauthProvider) {
		await app.pg.query(
			`INSERT INTO oauth_connections (provider_name, provider_id, user_id)
			VALUES ($1, $2, $3)`,
			[input.oauthProvider, `${input.oauthProvider}-${id}`, id],
		)
	}
	return { id, stableUserId, email: input.email, username: input.username }
}

async function usernames(app: AppDb) {
	const { rows } = await app.pg.query<{ username: string }>(
		`SELECT username FROM users ORDER BY username ASC`,
	)
	return rows.map((row) => row.username)
}

async function auditActions(audit: AuditDb) {
	const { rows } = await audit.pg.query<{
		category: string
		action: string
		result: string
		email_hash: string | null
		reason: string | null
	}>(
		`SELECT category, action, result, email_hash, reason
		FROM audit_events
		ORDER BY id ASC`,
	)
	return rows
}

test('purge deletes only aged unverified person accounts through full account deletion and writes an audit row', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const eligible = await seedUser(app, {
		username: 'stale-unverified',
		email: 'stale@example.com',
		createdAt: daysAgo(8),
	})
	await seedUser(app, {
		username: 'verified-old',
		email: 'verified@example.com',
		createdAt: daysAgo(30),
		emailVerifiedAt: daysAgo(29),
	})
	await seedUser(app, {
		username: 'young-unverified',
		email: 'young@example.com',
		createdAt: daysAgo(1),
	})
	await seedUser(app, {
		username: 'platform-unverified',
		email: 'platform@example.com',
		createdAt: daysAgo(30),
		accountType: 'platform',
	})
	await seedUser(app, {
		username: 'fenced-unverified',
		email: 'fenced@example.com',
		createdAt: daysAgo(30),
		deletingAt: minutesAgo(5),
	})
	await seedUser(app, {
		username: 'social-unverified',
		email: 'social@example.com',
		createdAt: daysAgo(30),
		oauthProvider: 'github',
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: eligible.stableUserId, ageDays: 8, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
	expect(deleteUserAccount).toHaveBeenCalledWith({
		env: expect.objectContaining({
			APP_DB: app.purgerFor(eligible.stableUserId),
		}),
		dbUserId: eligible.id,
		mcpUserId: eligible.stableUserId,
	})
	expect(await usernames(app)).toEqual([
		'fenced-unverified',
		'platform-unverified',
		'social-unverified',
		'verified-old',
		'young-unverified',
	])
	expect(await auditActions(audit)).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purged',
			result: 'success',
			email_hash: emailHash(eligible.email),
			reason: 'unverified_for_8_days',
		},
	])
})

test('purge walks oldest-first keyset pages and stops at the bounded batch size', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const oldest = await seedUser(app, {
		username: 'oldest',
		email: 'oldest@example.com',
		createdAt: daysAgo(11),
	})
	const second = await seedUser(app, {
		username: 'second',
		email: 'second@example.com',
		createdAt: daysAgo(10),
	})
	const third = await seedUser(app, {
		username: 'third',
		email: 'third@example.com',
		createdAt: daysAgo(9),
	})
	const fourth = await seedUser(app, {
		username: 'fourth',
		email: 'fourth@example.com',
		createdAt: daysAgo(8),
	})
	const env = createPurgeEnv(app, audit.db)

	const firstRun = await pruneUnverifiedAccounts({
		...env,
		now,
		batchSize: 2,
	})
	expect(firstRun).toEqual({
		scanned: 2,
		purged: 2,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: oldest.stableUserId, ageDays: 11, outcome: 'purged' },
			{ stableUserId: second.stableUserId, ageDays: 10, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[oldest.stableUserId, second.stableUserId],
	)
	expect(await usernames(app)).toEqual(['fourth', 'third'])

	deleteUserAccount.mockClear()
	const secondRun = await pruneUnverifiedAccounts({
		...env,
		now,
		batchSize: 2,
	})
	expect(secondRun.purged).toBe(2)
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[third.stableUserId, fourth.stableUserId],
	)
	expect(await usernames(app)).toEqual([])
	expect(await auditActions(audit)).toHaveLength(4)
})

test('a failed deletion is audited with a bounded reason, reported per account, and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const failing = await seedUser(app, {
		username: 'failing',
		email: 'failing@example.com',
		createdAt: daysAgo(12),
	})
	const surviving = await seedUser(app, {
		username: 'purged-after-failure',
		email: 'after@example.com',
		createdAt: daysAgo(11),
	})
	const last = await seedUser(app, {
		username: 'purged-last',
		email: 'last@example.com',
		createdAt: daysAgo(10),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError([
			'simulated inventory',
			'second inventory warning',
		])
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 3,
		purged: 2,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: failing.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'AccountDeletionInventoryError: simulated inventory',
				warnings: ['simulated inventory', 'second inventory warning'],
			},
			{ stableUserId: surviving.stableUserId, ageDays: 11, outcome: 'purged' },
			{ stableUserId: last.stableUserId, ageDays: 10, outcome: 'purged' },
		],
	})
	expect(JSON.stringify(result)).not.toContain('@example.com')
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: failing.stableUserId,
		warnings: ['simulated inventory', 'second inventory warning'],
		error: 'AccountDeletionInventoryError: simulated inventory',
	})
	expect(await usernames(app)).toEqual(['failing'])
	expect(await auditActions(audit)).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(failing.email),
			reason: 'AccountDeletionInventoryError: simulated inventory',
		},
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(surviving.email),
		}),
		expect.objectContaining({
			action: 'unverified_account_purged',
			reason: 'unverified_for_10_days',
		}),
	])
	expect(await deletingAt(app, 'failing')).toBeNull()

	deleteUserAccount.mockClear()
	const retry = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})
	expect(retry).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: failing.stableUserId, ageDays: 12, outcome: 'purged' },
		],
	})
	expect(await usernames(app)).toEqual([])
})

test('the failure audit reason falls back to the error message and is truncated', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const failing = await seedUser(app, {
		username: 'long-failure',
		email: 'long-failure@example.com',
		createdAt: daysAgo(9),
	})
	const other = await seedUser(app, {
		username: 'writers-active',
		email: 'writers-active@example.com',
		createdAt: daysAgo(8),
	})
	deleteUserAccount
		.mockImplementationOnce(async () => {
			throw new Error(`d1 timeout\n${'x'.repeat(400)}`)
		})
		.mockImplementationOnce(async () => {
			throw new AccountDeletionWritersActiveError(2)
		})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	const [truncated, writersActive] = result.outcomes
	expect(truncated).toMatchObject({
		stableUserId: failing.stableUserId,
		outcome: 'failed',
		warnings: [],
	})
	expect(truncated?.error).toHaveLength(
		unverifiedAccountPurgeFailureReasonMaxLength,
	)
	expect(truncated?.error).toMatch(/^Error: d1 timeout x+$/)
	expect(writersActive).toEqual({
		stableUserId: other.stableUserId,
		ageDays: 8,
		outcome: 'failed',
		error:
			'AccountDeletionWritersActiveError: Account deletion is waiting for 2 active user write(s) to finish.',
		warnings: [],
	})
	expect(await auditActions(audit)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(failing.email),
			reason: truncated?.error,
		}),
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(other.email),
			reason: writersActive?.error,
		}),
	])
	expect(await deletingAt(app, 'writers-active')).toBeNull()
})

test('failure details redact email addresses before they reach outcomes, audit rows, or logs', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const leaky = await seedUser(app, {
		username: 'leaky',
		email: 'leaky.person+tag@example.com',
		createdAt: daysAgo(9),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError([
			`Failed to enumerate Stripe customer id: no customer for ${leaky.email}`,
			`Failed to enumerate MCP servers: owner ${leaky.email} unreachable`,
		])
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	const [outcome] = result.outcomes
	expect(outcome).toEqual({
		stableUserId: leaky.stableUserId,
		ageDays: 9,
		outcome: 'failed',
		error:
			'AccountDeletionInventoryError: Failed to enumerate Stripe customer id: no customer for <email>',
		warnings: [
			'Failed to enumerate Stripe customer id: no customer for <email>',
			'Failed to enumerate MCP servers: owner <email> unreachable',
		],
	})
	expect(JSON.stringify(result)).not.toContain('@example.com')
	const [auditRow] = await auditActions(audit)
	expect(auditRow).toMatchObject({
		action: 'unverified_account_purge_failed',
		reason: outcome?.error,
	})
	expect(JSON.stringify(auditRow)).not.toContain('@example.com')
	expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('@example.com')
})

test('a Stripe cancellation failure is a pre-cleanup failure: fence released, account retained, retried next run', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const billing = await seedUser(app, {
		username: 'billing-failure',
		email: 'billing-failure@example.com',
		createdAt: daysAgo(12),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionBillingError([
			'Stripe subscription sub_1 could not be canceled: Stripe API request failed with HTTP 503.',
		])
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: billing.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error:
					'AccountDeletionBillingError: Stripe subscription sub_1 could not be canceled: Stripe API request failed with HTTP 503.',
				warnings: [
					'Stripe subscription sub_1 could not be canceled: Stripe API request failed with HTTP 503.',
				],
			},
		],
	})
	expect(await usernames(app)).toEqual(['billing-failure'])
	expect(await deletingAt(app, 'billing-failure')).toBeNull()

	deleteUserAccount.mockClear()
	const retry = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})
	expect(retry).toMatchObject({ scanned: 1, purged: 1, failed: 0 })
	expect(await usernames(app)).toEqual([])
})

test('a failed failure-audit write is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const failing = await seedUser(app, {
		username: 'failing-audit-down',
		email: 'failing-audit-down@example.com',
		createdAt: daysAgo(12),
	})
	const purged = await seedUser(app, {
		username: 'purged-after-audit-down',
		email: 'purged-after-audit-down@example.com',
		createdAt: daysAgo(11),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toMatchObject({ scanned: 2, purged: 1, failed: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{ userId: failing.stableUserId, error: expect.any(Error) },
	)
	expect(await usernames(app)).toEqual(['failing-audit-down'])
	expect(await auditActions(audit)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(purged.email),
		}),
	])
})

test('a failed fence release is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const abortAccountDeleting = vi.spyOn(DeletionState, 'abortAccountDeleting')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const stuck = await seedUser(app, {
		username: 'stuck-fence',
		email: 'stuck@example.com',
		createdAt: daysAgo(12),
	})
	const afterStuck = await seedUser(app, {
		username: 'purged-after-stuck',
		email: 'after-stuck@example.com',
		createdAt: daysAgo(11),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	abortAccountDeleting.mockImplementationOnce(async () => {
		throw new Error('simulated release failure')
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 2,
		purged: 1,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: stuck.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'AccountDeletionInventoryError: simulated inventory',
				warnings: ['simulated inventory'],
			},
			{ stableUserId: afterStuck.stableUserId, ageDays: 11, outcome: 'purged' },
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_release_failed',
		{ userId: stuck.stableUserId, error: expect.any(Error) },
	)
	expect(await usernames(app)).toEqual(['stuck-fence'])
	expect(await deletingAt(app, 'stuck-fence')).not.toBeNull()
})

test('a pre-existing fence is left in place when a restamped deletion fails', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const fenced = await seedUser(app, {
		username: 'restamp-fail',
		email: 'restamp-fail@example.com',
		createdAt: daysAgo(12),
		deletingAt: daysAgo(1),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new Error('simulated restamped deletion failure')
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: fenced.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'Error: simulated restamped deletion failure',
				warnings: [],
			},
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: fenced.stableUserId,
		warnings: [],
		error: 'Error: simulated restamped deletion failure',
	})
	expect(await usernames(app)).toEqual(['restamp-fail'])
	expect(await deletingAt(app, 'restamp-fail')).not.toBeNull()
	expect(await auditActions(audit)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(fenced.email),
			reason: 'Error: simulated restamped deletion failure',
		}),
	])
})

test('a cleanup error keeps a claim-created fence so the damaged account retries', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const damaged = await seedUser(app, {
		username: 'cleanup-fail',
		email: 'cleanup-fail@example.com',
		createdAt: daysAgo(8),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionCleanupError(
			['simulated cleanup'],
			emptyDeletionResult(),
		)
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: damaged.stableUserId,
				ageDays: 8,
				outcome: 'failed',
				error: 'AccountDeletionCleanupError: simulated cleanup',
				warnings: ['simulated cleanup'],
			},
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: damaged.stableUserId,
		warnings: ['simulated cleanup'],
		error: 'AccountDeletionCleanupError: simulated cleanup',
	})
	expect(await usernames(app)).toEqual(['cleanup-fail'])
	expect(await deletingAt(app, 'cleanup-fail')).not.toBeNull()
	expect(await auditActions(audit)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(damaged.email),
			reason: 'AccountDeletionCleanupError: simulated cleanup',
		}),
	])

	deleteUserAccount.mockClear()
	const retry = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})
	expect(retry).toEqual({
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(await usernames(app)).toEqual(['cleanup-fail'])
})

test('an audit failure after a successful delete does not stop the batch or release a fence', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const first = await seedUser(app, {
		username: 'audit-fail',
		email: 'audit-fail@example.com',
		createdAt: daysAgo(10),
	})
	const second = await seedUser(app, {
		username: 'audit-ok',
		email: 'audit-ok@example.com',
		createdAt: daysAgo(9),
	})
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 2,
		purged: 2,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: first.stableUserId, ageDays: 10, outcome: 'purged' },
			{ stableUserId: second.stableUserId, ageDays: 9, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{
			userId: first.stableUserId,
			error: expect.any(Error),
		},
	)
	expect(await usernames(app)).toEqual([])
	expect(await auditActions(audit)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(second.email),
		}),
	])
})

test('a claim that loses the race to verification keeps the account and writes no audit', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	const { db } = app
	await using audit = await createTestAuditDb()
	const raced = await seedUser(app, {
		username: 'verified-during-select',
		email: 'raced@example.com',
		createdAt: daysAgo(8),
	})
	const env = createPurgeEnv(
		app,
		audit.db,
		withVerifyAfterUnverifiedAccountSelect(db, now.toISOString()),
	)

	const result = await pruneUnverifiedAccounts({ ...env, now })

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: raced.stableUserId,
				ageDays: 8,
				outcome: 'skipped_claim',
			},
		],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(await usernames(app)).toEqual(['verified-during-select'])
	expect(await auditActions(audit)).toEqual([])
	const {
		rows: [row],
	} = await app.pg.query<{
		email_verified_at: string | null
		deleting_at: string | null
	}>(`SELECT email_verified_at, deleting_at FROM users WHERE id = $1`, [
		raced.id,
	])
	if (!row) throw new Error('raced account is missing')
	expect(row.email_verified_at).not.toBeNull()
	expect(row.deleting_at).toBeNull()
})

test('never-attempted accounts are purged before stale fences; in-backoff fences are skipped', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const staleFence = await seedUser(app, {
		username: 'stale-fence',
		email: 'stale-fence@example.com',
		createdAt: daysAgo(30),
		deletingAt: daysAgo(1),
	})
	const fresh = await seedUser(app, {
		username: 'fresh-unverified',
		email: 'fresh@example.com',
		createdAt: daysAgo(8),
	})
	await seedUser(app, {
		username: 'recent-fence',
		email: 'recent-fence@example.com',
		createdAt: daysAgo(20),
		deletingAt: minutesAgo(5),
	})
	const env = createPurgeEnv(app, audit.db)

	const firstRun = await pruneUnverifiedAccounts({
		...env,
		now,
		batchSize: 1,
	})
	expect(firstRun).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: fresh.stableUserId, ageDays: 8, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[fresh.stableUserId],
	)
	expect(await usernames(app)).toEqual(['recent-fence', 'stale-fence'])

	deleteUserAccount.mockClear()
	const secondRun = await pruneUnverifiedAccounts({
		...env,
		now,
		batchSize: 2,
	})
	expect(secondRun).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: staleFence.stableUserId, ageDays: 30, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[staleFence.stableUserId],
	)
	expect(await usernames(app)).toEqual(['recent-fence'])
	expect(await deletingAt(app, 'recent-fence')).not.toBeNull()
	expect(await auditActions(audit)).toHaveLength(2)
})

test('a zero time budget deletes nothing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	await seedUser(app, {
		username: 'would-purge',
		email: 'budget@example.com',
		createdAt: daysAgo(8),
	})

	const result = await pruneUnverifiedAccounts({
		...createPurgeEnv(app, audit.db),
		now,
		timeBudgetMs: 0,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: true,
		outcomes: [],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(await usernames(app)).toEqual(['would-purge'])
	expect(await deletingAt(app, 'would-purge')).toBeNull()
	expect(await auditActions(audit)).toEqual([])
})

test('listUnverifiedAccountPurgeCandidates previews the claim page without claiming, deleting, or auditing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	await using app = await createAppDb()
	await using audit = await createTestAuditDb()
	const staleFence = await seedUser(app, {
		username: 'preview-stale-fence',
		email: 'preview-stale-fence@example.com',
		createdAt: daysAgo(30),
		deletingAt: daysAgo(1),
	})
	const fresh = await seedUser(app, {
		username: 'preview-fresh',
		email: 'preview-fresh@example.com',
		createdAt: daysAgo(9),
	})
	await seedUser(app, {
		username: 'preview-young',
		email: 'preview-young@example.com',
		createdAt: daysAgo(2),
	})
	await seedUser(app, {
		username: 'preview-recent-fence',
		email: 'preview-recent-fence@example.com',
		createdAt: daysAgo(20),
		deletingAt: minutesAgo(5),
	})

	const preview = await listUnverifiedAccountPurgeCandidates({
		...createPurgeEnv(app, audit.db),
		now,
	})

	expect(preview).toEqual({
		scanned: 2,
		candidates: [
			{ stableUserId: fresh.stableUserId, ageDays: 9 },
			{ stableUserId: staleFence.stableUserId, ageDays: 30 },
		],
	})
	expect(JSON.stringify(preview)).not.toContain('@example.com')
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(await deletingAt(app, 'preview-fresh')).toBeNull()
	expect(await deletingAt(app, 'preview-stale-fence')).toBe(daysAgo(1))
	expect(await auditActions(audit)).toEqual([])
	expect(
		await listUnverifiedAccountPurgeCandidates({
			...createPurgeEnv(app, audit.db),
			now,
			batchSize: 1,
		}),
	).toEqual({
		scanned: 1,
		candidates: [{ stableUserId: fresh.stableUserId, ageDays: 9 }],
	})
})
