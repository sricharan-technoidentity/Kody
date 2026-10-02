import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { expect, test } from 'vitest'
import {
	claimJobRow,
	disableExpiredJobRowsForUser,
	finalizeClaimedJobRow,
	getJobRowById,
	getNextRunnableJobRow,
	jobExecutionLeaseMs,
	listDueJobRows,
	maxDueJobsPerAlarm,
	refreshPackageJobRowIdentity,
	retryClaimedJobRow,
	updateJobRow,
} from '@kody-internal/shared/jobs/repo.ts'

async function insertJob(
	database: Awaited<ReturnType<typeof createTestDb>>,
	input: {
		id: string
		userId: string
		nextRunAt: string
		enabled?: boolean
		killSwitchEnabled?: boolean
		expiresAt?: string | null
	},
) {
	const now = '2026-04-20T00:00:00.000Z'
	await database
		.forUser(input.userId)
		.db.prepare(
			`INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			enabled, kill_switch_enabled, expires_at, caller_context_json, created_at,
			updated_at, next_run_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.id,
			`source-${input.id}`,
			`job:${input.id}`,
			JSON.stringify({ type: 'once', runAt: input.nextRunAt }),
			'UTC',
			input.enabled === false ? 0 : 1,
			input.killSwitchEnabled === true ? 1 : 0,
			input.expiresAt ?? null,
			now,
			now,
			input.nextRunAt,
		)
		.run()
}

test('listDueJobRows caps a due-job backlog at maxDueJobsPerAlarm, oldest first', async () => {
	const userId = 'user-due-limit'
	await using database = await createTestDb({ userId })
	const db = database.db
	const nowIso = '2026-04-20T12:00:00.000Z'
	const backlogSize = maxDueJobsPerAlarm + 5
	for (let index = 0; index < backlogSize; index += 1) {
		await insertJob(database, {
			id: `due-${String(index).padStart(3, '0')}`,
			userId,
			nextRunAt: new Date(
				Date.parse('2026-04-20T00:00:00.000Z') + index * 60_000,
			).toISOString(),
		})
	}
	// Rows that must never be picked up: other user, disabled, kill-switched,
	// and not-yet-due jobs.
	await insertJob(database, {
		id: 'other-user',
		userId: 'user-other',
		nextRunAt: '2026-04-20T00:00:00.000Z',
	})
	await insertJob(database, {
		id: 'disabled',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		enabled: false,
	})
	await insertJob(database, {
		id: 'kill-switched',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		killSwitchEnabled: true,
	})
	await insertJob(database, {
		id: 'expired',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		expiresAt: '2026-04-19T23:00:00.000Z',
	})
	await insertJob(database, {
		id: 'future',
		userId,
		nextRunAt: '2026-04-21T00:00:00.000Z',
	})

	const firstBatch = await listDueJobRows(db, userId, nowIso)
	expect(firstBatch).toHaveLength(maxDueJobsPerAlarm)
	expect(firstBatch.map((row) => row.id)).toEqual(
		Array.from(
			{ length: maxDueJobsPerAlarm },
			(_, index) => `due-${String(index).padStart(3, '0')}`,
		),
	)

	// Once the first batch has been rescheduled out of the due window, the next
	// alarm invocation picks up the remainder of the backlog.
	for (const row of firstBatch) {
		await db
			.prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`)
			.bind('2026-04-22T00:00:00.000Z', row.id)
			.run()
	}
	const secondBatch = await listDueJobRows(db, userId, nowIso)
	expect(secondBatch.map((row) => row.id)).toEqual(
		Array.from(
			{ length: backlogSize - maxDueJobsPerAlarm },
			(_, index) =>
				`due-${String(maxDueJobsPerAlarm + index).padStart(3, '0')}`,
		),
	)
})

test('conditional job claims exclude overlap and reclaim only after lease expiry', async () => {
	const userId = 'user-claim'
	await using database = await createTestDb({ userId })
	const db = database.db
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	const now = new Date(scheduledFor)
	await insertJob(database, {
		id: 'claimed-job',
		userId,
		nextRunAt: scheduledFor,
	})

	const [first, overlap] = await Promise.all([
		claimJobRow({
			db: db,
			userId,
			jobId: 'claimed-job',
			now,
			claimToken: 'claim-first',
		}),
		claimJobRow({
			db: db,
			userId,
			jobId: 'claimed-job',
			now,
			claimToken: 'claim-overlap',
		}),
	])
	const winner = first ?? overlap
	expect(winner).not.toBeNull()
	expect([first, overlap].filter(Boolean)).toHaveLength(1)
	expect(winner?.claimed_scheduled_for).toBe(scheduledFor)
	expect(winner?.lease_expires_at).toBe(
		new Date(now.valueOf() + jobExecutionLeaseMs).toISOString(),
	)

	expect(
		await listDueJobRows(
			db,
			userId,
			new Date(now.valueOf() + jobExecutionLeaseMs - 1).toISOString(),
		),
	).toEqual([])
	const nextWhileLeased = await getNextRunnableJobRow(
		db,
		userId,
		now.toISOString(),
	)
	expect(nextWhileLeased?.schedulerWakeAt).toBe(winner?.lease_expires_at)

	const reclaimed = await claimJobRow({
		db: db,
		userId,
		jobId: 'claimed-job',
		now: new Date(now.valueOf() + jobExecutionLeaseMs),
		claimToken: 'claim-reclaimed',
	})
	expect(reclaimed?.claim_token).toBe('claim-reclaimed')
	expect(reclaimed?.claimed_scheduled_for).toBe(scheduledFor)

	const retryAt = '2026-04-20T12:10:05.000Z'
	expect(
		await retryClaimedJobRow({
			db: db,
			userId,
			jobId: 'claimed-job',
			claimToken: 'claim-reclaimed',
			nextRunAt: retryAt,
		}),
	).toBe(true)
	const retryRow = await getNextRunnableJobRow(
		db,
		userId,
		new Date('2026-04-20T12:10:00.000Z').toISOString(),
	)
	expect(retryRow).toMatchObject({
		claim_token: null,
		retry_scheduled_for: scheduledFor,
		retry_count: 1,
		schedulerWakeAt: retryAt,
	})
	const retriedOccurrence = await claimJobRow({
		db: db,
		userId,
		jobId: 'claimed-job',
		now: new Date(retryAt),
		claimToken: 'claim-retry',
	})
	expect(retriedOccurrence?.claimed_scheduled_for).toBe(scheduledFor)
	expect(retriedOccurrence?.retry_count).toBe(1)
})

test('job writes retain Aurora run anchors and default run-history fields', async () => {
	const userId = 'user-run-anchors'
	await using database = await createTestDb({ userId })
	const db = database.db
	await insertJob(database, {
		id: 'run-anchors',
		userId,
		nextRunAt: '2026-04-20T12:00:00.000Z',
	})
	const row = await getJobRowById(db, userId, 'run-anchors')
	if (!row) throw new Error('Expected job row.')

	const finishedAt = '2026-04-20T12:05:00.000Z'
	expect(
		await updateJobRow({
			db: db,
			userId,
			job: {
				...row.record,
				updatedAt: finishedAt,
				lastRunAt: finishedAt,
				lastRunStatus: 'success',
				lastRunError: 'RunLog-only error',
				lastDurationMs: 999,
				runCount: 99,
				successCount: 99,
				errorCount: 99,
			},
			callerContextJson: row.callerContextJson,
		}),
	).toBe(true)

	const updated = await getJobRowById(db, userId, 'run-anchors')
	expect(updated).toMatchObject({
		last_run_at: finishedAt,
		last_run_status: 'success',
		record: {
			lastRunAt: finishedAt,
			lastRunStatus: 'success',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
	})
	expect(updated).not.toHaveProperty('last_run_error')
	expect(updated).not.toHaveProperty('last_duration_ms')
	expect(updated?.record.lastRunError).toBeUndefined()
	expect(updated?.record.lastDurationMs).toBeUndefined()

	const scheduledFor = '2026-04-20T12:00:00.000Z'
	const claimed = await claimJobRow({
		db: db,
		userId,
		jobId: 'run-anchors',
		now: new Date('2026-04-20T12:10:00.000Z'),
		claimToken: 'claim-run-anchors',
	})
	if (!claimed) throw new Error('Expected job claim.')
	const refreshedCallerContextJson = JSON.stringify({
		user: { userId, email: 'refreshed@example.com' },
	})
	expect(
		await refreshPackageJobRowIdentity({
			db: db,
			userId,
			jobId: claimed.id,
			sourceId: 'refreshed-source',
			publishedCommit: 'refreshed-commit',
			callerContextJson: refreshedCallerContextJson,
			updatedAt: '2026-04-20T12:10:02.000Z',
		}),
	).toBe(true)
	const finalizedAt = '2026-04-20T12:10:05.000Z'
	expect(
		await finalizeClaimedJobRow({
			db: db,
			userId,
			job: {
				...claimed.record,
				updatedAt: finalizedAt,
				lastRunAt: finalizedAt,
				lastRunStatus: 'error',
			},
			claimToken: 'claim-run-anchors',
			scheduledFor,
		}),
	).toBe(true)
	expect(await getJobRowById(db, userId, 'run-anchors')).toMatchObject({
		last_run_at: finalizedAt,
		last_run_status: 'error',
		last_completed_scheduled_for: scheduledFor,
		source_id: 'refreshed-source',
		published_commit: 'refreshed-commit',
		caller_context_json: refreshedCallerContextJson,
		record: {
			lastRunAt: finalizedAt,
			lastRunStatus: 'error',
			lastRunError: undefined,
			lastDurationMs: undefined,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
	})
})

test('ordinary updates cancel claims and completed occurrence guards fence malformed due rows', async () => {
	const userId = 'user-fencing'
	await using database = await createTestDb({ userId })
	const db = database.db
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	await insertJob(database, {
		id: 'cancelled-claim',
		userId,
		nextRunAt: scheduledFor,
	})
	const claimed = await claimJobRow({
		db: db,
		userId,
		jobId: 'cancelled-claim',
		now: new Date(scheduledFor),
		claimToken: 'stale-token',
	})
	if (!claimed) throw new Error('Expected job claim.')

	expect(
		await updateJobRow({
			db: db,
			userId,
			job: {
				...claimed.record,
				name: 'Edited while claimed',
			},
			callerContextJson: claimed.callerContextJson,
		}),
	).toBe(true)
	expect(await getJobRowById(db, userId, claimed.id)).toMatchObject({
		name: 'Edited while claimed',
		claim_token: null,
		running_since: null,
		lease_expires_at: null,
		claimed_scheduled_for: null,
		retry_scheduled_for: null,
		retry_count: 0,
	})
	expect(
		await finalizeClaimedJobRow({
			db: db,
			userId,
			job: claimed.record,
			claimToken: 'stale-token',
			scheduledFor,
		}),
	).toBe(false)

	await insertJob(database, {
		id: 'already-completed',
		userId,
		nextRunAt: scheduledFor,
	})
	await db
		.prepare(
			`UPDATE jobs SET last_completed_scheduled_for = ? WHERE id = ? AND user_id = ?`,
		)
		.bind(scheduledFor, 'already-completed', userId)
		.run()
	const due = await listDueJobRows(db, userId, scheduledFor)
	expect(due.map((row) => row.id)).not.toContain('already-completed')
	expect(
		await claimJobRow({
			db: db,
			userId,
			jobId: 'already-completed',
			now: new Date(scheduledFor),
			claimToken: 'must-not-claim',
		}),
	).toBeNull()
})

test('expired jobs are skipped by due/claim/next-runnable and disableExpired flips enabled', async () => {
	const userId = 'user-expires'
	await using database = await createTestDb({ userId })
	const db = database.db
	const nowIso = '2026-04-20T12:00:00.000Z'
	await insertJob(database, {
		id: 'still-valid',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
		expiresAt: '2026-04-20T13:00:00.000Z',
	})
	await insertJob(database, {
		id: 'already-expired',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
		expiresAt: '2026-04-20T11:30:00.000Z',
	})
	await insertJob(database, {
		id: 'no-expiry',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
	})

	const due = await listDueJobRows(db, userId, nowIso)
	expect(due.map((row) => row.id).sort()).toEqual(['no-expiry', 'still-valid'])

	expect(
		await claimJobRow({
			db: db,
			userId,
			jobId: 'already-expired',
			now: new Date(nowIso),
			claimToken: 'should-fail',
		}),
	).toBeNull()

	const next = await getNextRunnableJobRow(db, userId, nowIso)
	expect(next?.id).toBe('no-expiry')

	expect(
		await disableExpiredJobRowsForUser({
			db: db,
			userId,
			nowIso,
		}),
	).toBe(1)
	const disabled = await getJobRowById(db, userId, 'already-expired')
	expect(disabled).toMatchObject({
		enabled: 0,
		expires_at: '2026-04-20T11:30:00.000Z',
	})
	expect(disabled?.record.expiresAt).toBe('2026-04-20T11:30:00.000Z')
})

test('getNextRunnableJobRow wakes at expires_at when it is earlier than next_run_at', async () => {
	const userId = 'user-expires-wake'
	await using database = await createTestDb({ userId })
	const db = database.db
	await insertJob(database, {
		id: 'expires-before-run',
		userId,
		nextRunAt: '2026-04-21T12:00:00.000Z',
		expiresAt: '2026-04-20T18:00:00.000Z',
	})
	const next = await getNextRunnableJobRow(
		db,
		userId,
		'2026-04-20T12:00:00.000Z',
	)
	expect(next).toMatchObject({
		id: 'expires-before-run',
		schedulerWakeAt: '2026-04-20T18:00:00.000Z',
	})
})
