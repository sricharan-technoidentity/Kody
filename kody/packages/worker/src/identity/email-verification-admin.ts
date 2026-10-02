import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import {
	loadAdminUserByTarget,
	loadAdminUserRowByStableUserId,
	type AdminUserListItem,
	type AdminUserTarget,
} from '#worker/admin/users-data.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritableDb,
} from '#worker/account/deletion-state.ts'
import { clearUserEmailVerificationDelivery } from '#worker/email/verification-delivery.ts'
import {
	buildEmailVerificationUrl,
	deleteEmailVerificationsForUser,
	insertEmailVerificationToken,
	retireOtherEmailVerificationTokens,
} from './email-verification-tokens.ts'

export class AdminEmailVerificationError extends Error {
	readonly code: 'not_found' | 'already_verified'

	constructor(code: 'not_found' | 'already_verified', message: string) {
		super(message)
		this.name = 'AdminEmailVerificationError'
		this.code = code
	}
}

/**
 * `db` reads and stamps `users` (the restricted admin role on PostgreSQL);
 * `forUser` supplies the target account's scoped writer for its token rows.
 */
type AccountWriter = (stableUserId: string) => SqlDatabase

export async function markAdminUserEmailVerified(
	db: SqlDatabase,
	input: AdminUserTarget & { now?: Date; forUser?: AccountWriter },
): Promise<AdminUserListItem> {
	const existing = await loadAdminUserByTarget(db, input)
	if (!existing) {
		throw new AdminEmailVerificationError('not_found', 'User not found.')
	}
	const existingRow = await loadAdminUserRowByStableUserId(
		db,
		existing.stableUserId,
	)
	if (!existingRow) {
		throw new AdminEmailVerificationError('not_found', 'User not found.')
	}
	await assertAccountWritableDb(db, existing.stableUserId)

	const now = input.now ?? new Date()
	const verifiedAt = existing.email_verified_at ?? now.toISOString()
	const stamped = await db
		.prepare(
			`UPDATE users
			 SET email_verified_at = COALESCE(email_verified_at, ?),
			     updated_at = ?
			 WHERE id = ? AND deleting_at IS NULL`,
		)
		.bind(verifiedAt, utcSqliteTimestamp(now), existingRow.id)
		.run()
	if ((stamped.meta.changes ?? 0) !== 1) {
		throw new AccountDeletionInProgressError()
	}
	await clearUserEmailVerificationDelivery(db, existingRow.id)
	await deleteEmailVerificationsForUser(
		input.forUser?.(existing.stableUserId) ?? db,
		existingRow.id,
	)

	const updated = await loadAdminUserByTarget(db, {
		stableUserId: existing.stableUserId,
	})
	if (!updated) {
		throw new AdminEmailVerificationError('not_found', 'User not found.')
	}
	return updated
}

export async function mintAdminEmailVerificationUrl(input: {
	db: SqlDatabase
	forUser?: AccountWriter
	appBaseUrl: string
	target: AdminUserTarget
	now?: Date
}): Promise<{ user: AdminUserListItem; verifyUrl: string; expiresAt: number }> {
	const existing = await loadAdminUserByTarget(input.db, input.target)
	if (!existing) {
		throw new AdminEmailVerificationError('not_found', 'User not found.')
	}
	if (existing.email_verified) {
		throw new AdminEmailVerificationError(
			'already_verified',
			'Email is already verified.',
		)
	}
	const existingRow = await loadAdminUserRowByStableUserId(
		input.db,
		existing.stableUserId,
	)
	if (!existingRow) {
		throw new AdminEmailVerificationError('not_found', 'User not found.')
	}
	await assertAccountWritableDb(input.db, existing.stableUserId)

	const accountDb = input.forUser?.(existing.stableUserId) ?? input.db
	const minted = await insertEmailVerificationToken({
		db: accountDb,
		userId: existingRow.id,
		now: input.now,
	})
	await retireOtherEmailVerificationTokens(
		accountDb,
		existingRow.id,
		minted.tokenHash,
	)
	const verifyUrl = buildEmailVerificationUrl({
		appBaseUrl: input.appBaseUrl,
		token: minted.token,
	}).toString()

	return {
		user: existing,
		verifyUrl,
		expiresAt: minted.expiresAt,
	}
}
