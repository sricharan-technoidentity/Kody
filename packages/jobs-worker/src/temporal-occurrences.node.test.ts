import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { type JobRecord } from '@kody-internal/shared/jobs/types.ts'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type JobsWorkerEnv } from './env.ts'
import { insertJobWithScheduleOutbox } from './schedule-outbox.ts'
import {
	claimTemporalJobOccurrence,
	finalizeTemporalJobOccurrence,
	listCloudflareDueJobs,
} from './temporal-occurrences.ts'

function createJobsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	return {
		sqlite,
		db,
		env: { JOBS_DB: db } as JobsWorkerEnv,
	}
}

function job(): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: 'user-1',
		name: 'Temporal occurrence',
		sourceId: 'source-1',
		publishedCommit: 'abc123',
		storageId: 'job:job-1',
		schedule: { type: 'once', runAt: '2026-12-01T10:00:00.000Z' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-09-22T10:00:00.000Z',
		updatedAt: '2026-09-22T10:00:00.000Z',
		nextRunAt: '2026-12-01T10:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
}

test('Temporal claims are idempotent and the occurrence fence rejects duplicate delivery', async () => {
	const { sqlite, db, env } = createJobsDb()
	await insertJobWithScheduleOutbox({
		db,
		userId: 'user-1',
		job: job(),
		callerContextJson: '{}',
	})
	const identity = sqlite
		.prepare(
			`UPDATE job_schedule_bindings SET backend = 'temporal'
			RETURNING temporal_user_hash, temporal_job_id`,
		)
		.get() as { temporal_user_hash: string; temporal_job_id: string }
	const request = {
		env,
		userHash: identity.temporal_user_hash,
		jobId: identity.temporal_job_id,
		scheduledFor: '2026-12-01T10:00:00.000Z',
		claimRef: 'claim-1',
		now: new Date('2026-12-01T10:00:01.000Z'),
	}

	await expect(claimTemporalJobOccurrence(request)).resolves.toEqual({
		claimed: true,
		claimRef: 'claim-1',
	})
	await expect(claimTemporalJobOccurrence(request)).resolves.toEqual({
		claimed: true,
		claimRef: 'claim-1',
	})
	await expect(
		claimTemporalJobOccurrence({ ...request, claimRef: 'claim-2' }),
	).resolves.toEqual({ claimed: false, reason: 'claim-held' })
	expect(consoleInfo.mock.calls.slice(0, 3)).toEqual([
		[
			'temporal_job_occurrence_claim',
			{ outcome: 'claimed', scheduleToClaimLagMs: 1_000 },
		],
		[
			'temporal_job_occurrence_claim',
			{ outcome: 'idempotent_replay', scheduleToClaimLagMs: 1_000 },
		],
		[
			'temporal_job_occurrence_claim',
			{ outcome: 'claim_held', scheduleToClaimLagMs: 1_000 },
		],
	])
	await expect(
		finalizeTemporalJobOccurrence({
			env,
			userHash: request.userHash,
			jobId: request.jobId,
			claimRef: request.claimRef,
			scheduledFor: request.scheduledFor,
			status: 'succeeded',
			finishedAt: '2026-12-01T10:00:03.000Z',
		}),
	).resolves.toBe(true)
	await expect(claimTemporalJobOccurrence(request)).resolves.toEqual({
		claimed: false,
		reason: 'already-completed',
	})
	expect(consoleInfo).toHaveBeenLastCalledWith(
		'temporal_job_occurrence_claim',
		{ outcome: 'already_completed', scheduleToClaimLagMs: 1_000 },
	)
	await expect(
		listCloudflareDueJobs({
			env,
			userId: 'user-1',
			nowIso: '2026-12-01T10:00:05.000Z',
		}),
	).resolves.toEqual([])
	const stored = sqlite.prepare(`SELECT * FROM jobs`).get() as Record<
		string,
		unknown
	>
	expect(stored).toMatchObject({
		enabled: 0,
		claim_token: null,
		last_run_status: 'success',
		last_completed_scheduled_for: request.scheduledFor,
	})
})
