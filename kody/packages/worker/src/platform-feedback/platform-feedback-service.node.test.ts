import { expect, test, vi } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	getPlatformFeedbackByIdForAdmin,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import {
	getPlatformFeedbackForAdmin,
	listPlatformFeedbackForAdmin,
	submitPlatformFeedback,
	updatePlatformFeedbackForAdmin,
} from './service.ts'

async function createPlatformFeedbackDb() {
	const database = await createTestDb()
	const operator = createPgDatabase({
		connection: database.pg,
		role: 'kody_admin',
	})
	const queries: Array<string> = []
	return {
		...database,
		queries,
		// Operator review runs only after the application permission check.
		admin: {
			...operator,
			prepare(sql: string) {
				queries.push(sql.trim())
				return operator.prepare(sql)
			},
		},
		submitter: (userId: string) => database.forUser(userId).db,
	}
}

test('platform feedback workflow submits, lists, reads, transitions, and preserves submitter attribution', async () => {
	await using database = await createPlatformFeedbackDb()
	const { admin: db, queries, submitter } = database
	const first = await submitPlatformFeedback({
		db: submitter('user-a'),
		submitterUserId: 'user-a',
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
		category: 'friction',
		summary: '  Setup is confusing  ',
		details: '  The setup flow does not explain the next action.  ',
	})
	const second = await submitPlatformFeedback({
		db: submitter('user-b'),
		submitterUserId: 'user-b',
		submitterUsername: 'user-b-name',
		submitterEmail: 'user-b@example.com',
		category: 'bug',
		summary: 'Button does not save',
		details: 'The save button leaves the form unchanged.',
	})
	const third = await submitPlatformFeedback({
		db: submitter('user-a'),
		submitterUserId: 'user-a',
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
		category: 'experience',
		summary: 'Search feels slow',
		details: 'Search takes several seconds to show the first result.',
	})

	expect(first).toMatchObject({
		submitterUserId: 'user-a',
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
		status: 'open',
	})
	expect(second.submitterUserId).toBe('user-b')
	expect(third.submitterUserId).toBe('user-a')

	// Submitters cannot attribute feedback to someone else or read other rows,
	// and the operator role reviews feedback without being able to author it.
	const forged = {
		submitterUserId: 'user-b',
		submitterUsername: 'user-b-name',
		submitterEmail: 'user-b@example.com',
		category: 'bug' as const,
		summary: 'Forged',
		details: 'Attributed to another account.',
	}
	await expect(
		submitPlatformFeedback({ db: submitter('user-a'), ...forged }),
	).rejects.toThrow('row-level security')
	await expect(submitPlatformFeedback({ db, ...forged })).rejects.toThrow(
		'permission denied',
	)
	expect(
		await getPlatformFeedbackForAdmin({
			db: submitter('user-b'),
			feedbackId: first.id,
		}),
	).toBeNull()
	expect(
		(await listPlatformFeedbackForAdmin({ db: submitter('user-a') })).total,
	).toBe(2)

	const page = await listPlatformFeedbackForAdmin({
		db,
		page: 1,
		pageSize: 2,
	})
	expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 })
	expect(page.items).toHaveLength(2)
	for (const item of page.items) {
		expect(Object.keys(item).sort()).toEqual(
			[
				'category',
				'createdAt',
				'id',
				'reviewedAt',
				'reviewedByUserId',
				'status',
				'submitterUserId',
				'summary',
				'updatedAt',
			].sort(),
		)
		expect(item).not.toHaveProperty('submitterUsername')
		expect(item).not.toHaveProperty('submitterEmail')
	}
	queries.length = 0
	const clampedPage = await listPlatformFeedbackForAdmin({
		db,
		page: 99,
		pageSize: 2,
	})
	expect(clampedPage).toMatchObject({ total: 3, page: 2, pageSize: 2 })
	expect(clampedPage.items).toHaveLength(1)
	expect(
		queries.filter((query) => query.startsWith('SELECT COUNT(*) AS total')),
	).toHaveLength(1)
	expect(
		queries.filter((query) =>
			query.startsWith('SELECT id, submitter_user_id, category, summary'),
		),
	).toHaveLength(2)
	const bugFeedback = await listPlatformFeedbackForAdmin({
		db,
		status: 'open',
		category: 'bug',
	})
	expect(bugFeedback).toMatchObject({ page: 1, pageSize: 20, total: 1 })
	expect(bugFeedback.items).toEqual([
		expect.objectContaining({
			id: second.id,
			submitterUserId: 'user-b',
		}),
	])

	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: first.id }),
	).toMatchObject({
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
	})
	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: second.id }),
	).toMatchObject({
		id: second.id,
		submitterUsername: 'user-b-name',
		submitterEmail: 'user-b@example.com',
		details: 'The save button leaves the form unchanged.',
		adminNote: null,
	})

	const triaged = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-a',
		action: 'triage',
		adminNote: 'Needs setup-flow review.',
	})
	expect(triaged).toMatchObject({
		previousStatus: 'open',
		didChangeStatus: true,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-a',
			adminNote: 'Needs setup-flow review.',
		},
	})
	const correctedTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-b',
		action: 'triage',
		adminNote: 'Corrected setup-flow note.',
	})
	expect(correctedTriage).toMatchObject({
		previousStatus: 'triaged',
		didChangeStatus: false,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-b',
			adminNote: 'Corrected setup-flow note.',
		},
	})
	expect(
		await updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-c',
			action: 'triage',
			adminNote: 'Corrected setup-flow note.',
		}),
	).toEqual(correctedTriage)
	const clearedTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-c',
		action: 'triage',
		adminNote: '   ',
	})
	expect(clearedTriage).toMatchObject({
		didChangeStatus: false,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-c',
			adminNote: null,
		},
	})
	const restoredTriage = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-d',
		action: 'triage',
		adminNote: 'Preserve this note when resolving.',
	})
	expect(restoredTriage.feedback.adminNote).toBe(
		'Preserve this note when resolving.',
	)

	const resolved = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-e',
		action: 'resolve',
	})
	expect(resolved).toMatchObject({
		previousStatus: 'triaged',
		didChangeStatus: true,
		feedback: {
			status: 'resolved',
			reviewedByUserId: 'admin-e',
			adminNote: 'Preserve this note when resolving.',
		},
	})
	const resolvedAgain = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: first.id,
		reviewerUserId: 'admin-c',
		action: 'resolve',
	})
	expect(resolvedAgain.feedback).toEqual(resolved.feedback)
	expect(resolvedAgain).toMatchObject({
		previousStatus: 'resolved',
		didChangeStatus: false,
	})
	await expect(
		updatePlatformFeedbackForAdmin({
			db,
			feedbackId: first.id,
			reviewerUserId: 'admin-c',
			action: 'dismiss',
		}),
	).rejects.toThrow(
		`Cannot dismiss platform feedback "${first.id}" from status "resolved".`,
	)
	await expect(
		updatePlatformFeedbackForAdmin({
			db,
			feedbackId: 'missing-feedback',
			reviewerUserId: 'admin-a',
			action: 'triage',
		}),
	).rejects.toThrow('Platform feedback "missing-feedback" was not found.')
	// Review metadata is the operator's only writable surface.
	await expect(
		db
			.prepare('UPDATE platform_feedback SET summary = ? WHERE id = ?')
			.bind('Rewritten', second.id)
			.run(),
	).rejects.toThrow('permission denied')

	const { rows } = await database.pg.query<{
		id: string
		submitter_user_id: string
		submitter_username: string
		submitter_email: string
	}>(
		`SELECT id, submitter_user_id, submitter_username, submitter_email
		 FROM platform_feedback
		 ORDER BY submitter_user_id, id`,
	)
	expect(rows.filter((row) => row.submitter_user_id === 'user-a')).toHaveLength(
		2,
	)
	expect(rows.find((row) => row.id === first.id)).toMatchObject({
		submitter_username: 'user-a-name',
		submitter_email: 'user-a@example.com',
	})
	expect(rows.filter((row) => row.submitter_user_id === 'user-b')).toEqual([
		{
			id: second.id,
			submitter_user_id: 'user-b',
			submitter_username: 'user-b-name',
			submitter_email: 'user-b@example.com',
		},
	])
})

test('platform feedback admin note updates reject the same stale revision', async () => {
	await using database = await createPlatformFeedbackDb()
	const { admin: db } = database
	const submitted = await submitPlatformFeedback({
		db: database.submitter('user-a'),
		submitterUserId: 'user-a',
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
	})
	const stale = await getPlatformFeedbackByIdForAdmin(db, submitted.id)
	expect(stale).not.toBeNull()
	if (!stale) throw new Error('Expected submitted platform feedback.')
	expect(stale.revision).toBe(0)

	const firstUpdate = await updatePlatformFeedbackStatusForAdmin(db, {
		feedbackId: stale.id,
		expectedStatus: stale.status,
		expectedRevision: stale.revision,
		status: stale.status,
		reviewedByUserId: 'admin-a',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'First competing note.',
	})
	const staleUpdate = await updatePlatformFeedbackStatusForAdmin(db, {
		feedbackId: stale.id,
		expectedStatus: stale.status,
		expectedRevision: stale.revision,
		status: stale.status,
		reviewedByUserId: 'admin-b',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'Second competing note.',
	})
	expect(firstUpdate).toBe(true)
	expect(staleUpdate).toBe(false)

	const current = await getPlatformFeedbackByIdForAdmin(db, submitted.id)
	expect(current).toMatchObject({
		status: 'open',
		reviewedByUserId: 'admin-a',
		adminNote: 'First competing note.',
		revision: 1,
	})
	const publicRecord = await getPlatformFeedbackForAdmin({
		db,
		feedbackId: submitted.id,
	})
	expect(publicRecord).not.toHaveProperty('revision')
})

test('platform feedback submission enforces the rolling rate limit and atomic active queue cap', async () => {
	await using database = await createPlatformFeedbackDb()
	const { pg, submitter } = database
	const countFeedback = async (userId: string, statuses?: string) => {
		const { rows } = await pg.query<{ total: number }>(
			`SELECT COUNT(*)::int AS total FROM platform_feedback
			 WHERE submitter_user_id = $1 ${statuses ? `AND status IN (${statuses})` : ''}`,
			[userId],
		)
		return rows[0]?.total
	}
	const submit = (userId: string, summary: string) =>
		submitPlatformFeedback({
			db: submitter(userId),
			submitterUserId: userId,
			submitterUsername: userId,
			submitterEmail: `${userId}@example.com`,
			category: 'friction',
			summary,
			details: `${summary} details`,
		})
	for (let index = 0; index < 10; index += 1) {
		await submit('rate-limited-user', `Feedback ${index}`)
	}
	await expect(submit('rate-limited-user', 'Feedback 11')).rejects.toThrow(
		'Platform feedback is limited to 10 submissions per rolling 24 hours. Retry after 86400 seconds.',
	)
	expect(await countFeedback('rate-limited-user')).toBe(10)

	const insertFeedback = (input: {
		id: string
		userId: string
		status: string
		createdAt: string
	}) =>
		pg.query(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, submitter_username, submitter_email,
				category, summary, details, status, created_at, updated_at
			) VALUES ($1, $2, $2, $2 || '@example.com', 'friction', $1, $1, $3, $4, $4)`,
			[input.id, input.userId, input.status, input.createdAt],
		)
	// Only Date is faked: PGlite schedules its own work on real timers.
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const now = new Date('2026-07-19T12:00:00.000Z')
		vi.setSystemTime(now)
		const createdAt = new Date(
			now.getTime() - 23 * 60 * 60 * 1_000,
		).toISOString()
		for (let index = 0; index < 10; index += 1) {
			await insertFeedback({
				id: `feedback-${index}`,
				userId: 'windowed-user',
				status: 'open',
				createdAt,
			})
		}
		await expect(submit('windowed-user', 'Feedback 11')).rejects.toThrow(
			'Platform feedback is limited to 10 submissions per rolling 24 hours. Retry after 3600 seconds.',
		)
	} finally {
		vi.useRealTimers()
	}

	const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString()
	for (let index = 0; index < 99; index += 1) {
		await insertFeedback({
			id: `queued-${index}`,
			userId: 'queue-limited-user',
			status: index % 2 === 0 ? 'open' : 'triaged',
			createdAt,
		})
	}
	await submit('queue-limited-user', 'One hundredth active submission')
	await expect(
		submit('queue-limited-user', 'One over the active queue boundary'),
	).rejects.toThrow(
		'You already have 100 open or triaged platform feedback submissions.',
	)
	await pg.query(
		`UPDATE platform_feedback SET status = 'resolved', updated_at = $1
		 WHERE id = 'queued-0'`,
		[createdAt],
	)
	await submit('queue-limited-user', 'Replacement active submission')
	expect(await countFeedback('queue-limited-user', `'open', 'triaged'`)).toBe(
		100,
	)
})

test('platform feedback accepts the cancellation category', async () => {
	await using database = await createPlatformFeedbackDb()
	const submitted = await submitPlatformFeedback({
		db: database.submitter('user-c'),
		submitterUserId: 'user-c',
		submitterUsername: 'user-c-name',
		submitterEmail: 'user-c@example.com',
		category: 'cancellation',
		summary: 'Subscription cancellation feedback',
		details: 'Too expensive for my current usage.',
	})
	expect(submitted.category).toBe('cancellation')
	expect(
		(
			await database.pg.query(
				'SELECT category FROM platform_feedback WHERE id = $1',
				[submitted.id],
			)
		).rows,
	).toEqual([{ category: 'cancellation' }])
})
