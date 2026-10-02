import { expect, test, vi } from 'vitest'
import { logAuditEvent, queryAuditLog } from './audit-log.ts'
import { createTestAuditDb } from '#worker/test-support/aws/test-audit-db.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

vi.unmock('#worker/audit-log.ts')

test('persisted audit events write only the dedicated sink while optional persistence stays optional', async () => {
	await using audit = await createTestAuditDb()
	await using app = await createTestDb()

	await logAuditEvent({
		db: audit.db,
		category: 'auth',
		action: 'authenticate',
		result: 'failure',
		email: 'Person@Example.com',
		ip: '192.0.2.1',
		path: '/login',
		reason: 'invalid_password',
	})
	await logAuditEvent({
		db: undefined,
		category: 'account',
		action: 'profile_view',
		result: 'success',
	})

	const query = `SELECT category, action, result, email_hash, ip_hash, path, reason
		FROM audit_events`
	const auditRows = (await audit.reader.prepare(query).all()).results
	expect(auditRows).toEqual([
		{
			category: 'auth',
			action: 'authenticate',
			result: 'failure',
			email_hash:
				'542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345',
			ip_hash:
				'37fcff24bf62035b2b08020afc08b4fecd4fcffce57ab23518e3561ff0fe76b9',
			path: '/login',
			reason: 'invalid_password',
		},
	])
	const queried = await queryAuditLog(audit.reader, {
		user: ' PERSON@example.com ',
		category: 'auth',
		limit: 1,
	})
	expect(queried).toMatchObject({
		total: 1,
		limit: 1,
		page: 1,
		events: [{ action: 'authenticate' }],
	})
	expect((await queryAuditLog(audit.reader, { action: 'other' })).total).toBe(0)
	expect(
		(await queryAuditLog(audit.reader, { page: 2, limit: 1 })).events,
	).toEqual([])
	await expect(
		audit.db.prepare('SELECT * FROM audit_events').all(),
	).rejects.toThrow('permission denied')
	for (const sql of [
		"UPDATE audit_events SET reason = 'erased'",
		'DELETE FROM audit_events',
		'TRUNCATE audit_events',
	]) {
		await expect(
			audit.pg.transaction(async (tx) => {
				await tx.query('SET LOCAL ROLE kody_audit_writer')
				await tx.query(sql)
			}),
		).rejects.toThrow('permission denied')
	}
	await expect(
		audit.reader
			.prepare(
				"INSERT INTO audit_events (category, action, result, timestamp) VALUES ('auth', 'bad', 'success', 'now')",
			)
			.run(),
	).rejects.toThrow('read-only transaction')
	await expect(
		app.db.prepare('SELECT * FROM audit_events').all(),
	).rejects.toThrow('does not exist')
	await expect(
		audit.reader.prepare('SELECT * FROM users').all(),
	).rejects.toThrow('does not exist')
})

function createAuditDbWithRun(run: () => Promise<unknown>) {
	return {
		prepare() {
			return {
				bind() {
					return { run }
				},
			}
		},
	} as unknown as PgDatabase
}

test('audit writes report sink failures without retrying an ambiguous append', async () => {
	consoleWarn.mockImplementation(() => {})
	const transientRun = vi
		.fn()
		.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
		.mockResolvedValueOnce({ meta: { changes: 1 } })
	const retryResult = await logAuditEvent({
		db: createAuditDbWithRun(transientRun),
		category: 'account',
		action: 'transient_retry',
		result: 'success',
	})
	expect(retryResult).toEqual({ persisted: false, failedSinks: ['AUDIT_DB'] })
	expect(transientRun).toHaveBeenCalledTimes(1)

	const failedAuditResult = await logAuditEvent({
		db: createAuditDbWithRun(() =>
			Promise.reject(new Error('AUDIT_DB permanent failure')),
		),
		category: 'account',
		action: 'audit_failed',
		result: 'failure',
	})
	expect(failedAuditResult).toEqual({
		persisted: false,
		failedSinks: ['AUDIT_DB'],
	})

	const missingBindingResult = await logAuditEvent({
		db: null,
		category: 'account',
		action: 'audit_binding_missing',
		result: 'failure',
	})
	expect(missingBindingResult).toEqual({
		persisted: false,
		failedSinks: ['AUDIT_DB'],
	})
	expect(consoleWarn).toHaveBeenCalledTimes(3)
	expect(consoleWarn).toHaveBeenCalledWith('audit-event-write-failed', {
		failedSinks: ['AUDIT_DB'],
		errors: [expect.any(Error)],
	})
})
