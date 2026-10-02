import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createFakeRunLog } from '#worker/test-support/package-invocations.ts'
import {
	createRunRow,
	createTestRunRecords,
} from '#worker/test-support/run-records.ts'
import { type RunRecordsRpc } from './run-log-types.ts'
import {
	abandonRunRecord,
	beginRunRecord,
	bulkUpdateRunErrorTriage,
	claimPackageInvocationRecord,
	claimRunRecord,
	clearRunRecords,
	finishPackageInvocationRecord,
	finishRunRecord,
	getRunRecord,
	getRunRecordByIdempotencyKey,
	listRunRecords,
	recordRunRecord,
	snapshotRunRecordResult,
	summarizeRunRecords,
	updateRunErrorTriage,
} from './service.ts'
import {
	runRecordMaxLogEntriesPerRun,
	runRecordMaxResultSnapshotBytes,
	runRecordMaxRunsPerUser,
	runRecordPlatformInterruptedErrorName,
	runRecordRetentionDays,
	runRecordStaleRunningTtlMsJob,
	runRecordStaleRunningTtlMsShortLived,
	type RunErrorTriage,
	type RunRecordContext,
	type RunRecordHandle,
	type RunStatus,
	type RunSurface,
} from './types.ts'

// Run-error subscription fan-out reads APP_DB; it has its own suite.
vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
}))

// One run store (DynamoDB + S3 fakes) for the file; unique user ids isolate tests.
const runRecords = createTestRunRecords()
const env = runRecords.env as unknown as Env
/** Same tables, cap pass on every finish (the DO's "retention due" state). */
const retentionEnv = {
	RUN_RECORDS: runRecords.reopen({ retentionEveryNFinishes: 1 }),
} as unknown as Env
/** Same tables, no cap pass while seeding. */
const seeder = runRecords.reopen({
	retentionEveryNFinishes: Number.POSITIVE_INFINITY,
})

function uniqueUserId(label: string) {
	return `run-records-${label}-${crypto.randomUUID()}`
}

function baseContext(overrides?: Partial<RunRecordContext>): RunRecordContext {
	return {
		surface: 'job',
		name: 'example-job',
		...overrides,
	}
}

async function drainWaitUntil(pending: Array<Promise<unknown>>) {
	await Promise.all(pending)
	pending.length = 0
}

/** Write a stored row directly through the run store (no service policy). */
async function seedRun(
	store: RunRecordsRpc,
	input: {
		id: string
		status: RunStatus
		startedAt: string
		surface?: RunSurface
		jobId?: string | null
		errorMessage?: string | null
		errorTriage?: RunErrorTriage | null
		idempotencyKey?: string | null
	},
) {
	const run = createRunRow({
		id: input.id,
		surface: input.surface ?? 'job',
		status: input.status,
		startedAt: input.startedAt,
		finishedAt: input.status === 'running' ? null : input.startedAt,
		jobId: input.jobId ?? null,
		errorName: input.status === 'error' ? 'Error' : null,
		errorMessage: input.errorMessage ?? null,
		idempotencyKey: input.idempotencyKey ?? null,
	})
	if (input.status === 'running') await store.startRun({ run })
	else await store.finishRun({ run, logs: [] })
	if (input.errorTriage) {
		await store.updateRunErrorTriage({
			runId: input.id,
			errorTriage: input.errorTriage,
			triageNote: null,
			triagedBy: 'seed',
		})
	}
}

/** Stored run rows for one user, straight from the table. */
function storedRuns(userId: string) {
	return runRecords.dynamo
		.items(runRecords.tableName)
		.filter((item) => item.pk?.S === userId && item.sk?.S?.startsWith('run#'))
		.map((item) => ({
			id: item.id!.S!,
			status: item.status!.S!,
			errorTriage: item.errorTriage?.S ?? null,
		}))
}

test('write surfaces journey', async () => {
	// --- eager begin/finish → success with log count ---
	const userId = uniqueUserId('write-surfaces')
	const pending: Array<Promise<unknown>> = []
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'job', jobId: 'job-1' }),
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	expect(handle).not.toBeNull()
	await drainWaitUntil(pending)
	expect((await listRunRecords({ env, userId })).runs[0]?.status).toBe(
		'running',
	)
	await finishRunRecord({ env, handle, status: 'success', logs: ['done'] })
	const page = await listRunRecords({ env, userId })
	expect(page.runs).toHaveLength(1)
	expect(page.runs[0]).toMatchObject({
		status: 'success',
		surface: 'job',
		jobId: 'job-1',
		logCount: 1,
	})

	// --- finish-only upsert when startRun never landed ---
	const userId2 = uniqueUserId('finish-only')
	const orphanHandle: RunRecordHandle = {
		id: crypto.randomUUID(),
		userId: userId2,
		startedAt: new Date().toISOString(),
		persistence: 'eager',
		context: baseContext({
			surface: 'workflow',
			workflowId: 'wf-1',
			name: 'solo-finish',
		}),
	}
	await finishRunRecord({
		env,
		handle: orphanHandle,
		status: 'success',
		logs: [{ level: 'info', message: 'finished without start' }],
	})
	const orphanDetail = await getRunRecord({
		env,
		userId: userId2,
		runId: orphanHandle.id,
	})
	expect(orphanDetail?.run).toMatchObject({
		status: 'success',
		surface: 'workflow',
		workflowId: 'wf-1',
	})
	expect(orphanDetail?.logs).toEqual([
		{
			runId: orphanHandle.id,
			sequence: 0,
			level: 'info',
			message: 'finished without start',
			fields: null,
		},
	])

	// --- recordRunRecord one-shot terminal write ---
	const userId3 = uniqueUserId('record-one-shot')
	const shotHandle = await recordRunRecord({
		env,
		userId: userId3,
		context: baseContext({ surface: 'webhook', name: 'hook-a' }),
		status: 'success',
		logs: ['delivered'],
	})
	expect(shotHandle).not.toBeNull()
	const shotDetail = await getRunRecord({
		env,
		userId: userId3,
		runId: shotHandle!.id,
	})
	expect(shotDetail?.run).toMatchObject({
		status: 'success',
		surface: 'webhook',
		name: 'hook-a',
	})
	expect(shotDetail?.logs).toHaveLength(1)

	// --- finishRunRecord returns synchronously when waitUntil is provided ---
	const userId4 = uniqueUserId('finish-wait-until')
	const waitHandle: RunRecordHandle = {
		id: crypto.randomUUID(),
		userId: userId4,
		startedAt: new Date().toISOString(),
		persistence: 'eager',
		context: baseContext({ surface: 'export', name: 'bg-finish' }),
	}
	const waitPending: Array<Promise<unknown>> = []
	await expect(
		finishRunRecord({
			env,
			handle: waitHandle,
			status: 'success',
			logs: ['async'],
			waitUntil: (promise) => {
				waitPending.push(promise)
			},
		}),
	).resolves.toBe(true)
	expect(waitPending).toHaveLength(1)
	await drainWaitUntil(waitPending)
	expect(
		(await getRunRecord({ env, userId: userId4, runId: waitHandle.id }))?.run
			.status,
	).toBe('success')

	// --- execute is eager (success and error persist); key-less export stays on-failure ---
	const userId5 = uniqueUserId('execute-policy')
	const successHandle = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'execute', name: 'ok' }),
	})
	expect(successHandle?.persistence).toBe('eager')
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		result: { ok: true },
		logs: ['persisted'],
	})
	const successDetail = await getRunRecord({
		env,
		userId: userId5,
		runId: successHandle!.id,
	})
	expect(successDetail?.run).toMatchObject({
		status: 'success',
		surface: 'execute',
		name: 'ok',
		idempotencyKey: null,
	})
	expect(successDetail?.logs.map((entry) => entry.message)).toEqual([
		'persisted',
	])
	expect(successDetail?.run.metadata['result']).toEqual({ ok: true })

	const leanExport = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'export', name: 'lean-ok' }),
	})
	expect(leanExport?.persistence).toBe('on-failure')
	await finishRunRecord({
		env,
		handle: leanExport,
		status: 'success',
		result: { ignored: true },
		logs: ['should not persist'],
	})
	expect(
		await listRunRecords({
			env,
			userId: userId5,
			filter: { surface: 'export' },
		}),
	).toEqual({ runs: [], nextCursor: null })

	const errorHandle = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'execute', name: 'boom' }),
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('execute failed'),
		logs: ['error log'],
	})
	const execPage = await listRunRecords({
		env,
		userId: userId5,
		filter: { surface: 'execute' },
	})
	expect(execPage.runs).toHaveLength(2)
	expect(execPage.runs.find((run) => run.id === errorHandle!.id)).toMatchObject(
		{
			status: 'error',
			errorName: 'Error',
			errorMessage: 'execute failed',
			surface: 'execute',
		},
	)
	expect(execPage.runs.map((run) => run.id)).toContain(successHandle!.id)
})

test('logs round-trip in sequence order and keep only the newest 200', async () => {
	const userId = uniqueUserId('logs-cap')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'workflow' }),
	})
	const totalLogs = runRecordMaxLogEntriesPerRun + 50
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: [
			...Array.from({ length: totalLogs - 1 }, (_, index) => `log-${index}`),
			// The sandbox's `[level] ` marker becomes a structured level.
			`[warn] log-${totalLogs - 1}`,
		],
	})
	const detail = await getRunRecord({ env, userId, runId: handle!.id })
	expect(detail?.logs).toHaveLength(runRecordMaxLogEntriesPerRun)
	expect(detail?.logs[0]).toMatchObject({ sequence: 0, message: 'log-50' })
	expect(detail?.logs.at(-1)).toMatchObject({
		sequence: runRecordMaxLogEntriesPerRun - 1,
		level: 'warn',
		message: `log-${totalLogs - 1}`,
	})
	expect(detail?.run.logCount).toBe(runRecordMaxLogEntriesPerRun)
	// One S3 object per run holds its lines.
	expect(
		runRecords.logs.objects.has(`run-logs/${userId}/${handle!.id}.json`),
	).toBe(true)
})

test('listRunRecords filters by surface/status/jobId/name and paginates with cursors', async () => {
	const userId = uniqueUserId('list-filter')
	const startedAtBase = Date.now() - 60_000
	for (let index = 0; index < 5; index += 1) {
		await finishRunRecord({
			env,
			handle: {
				id: `run-${index}`,
				userId,
				startedAt: new Date(startedAtBase + index * 1000).toISOString(),
				persistence: 'eager',
				context: baseContext({
					surface: index % 2 === 0 ? 'job' : 'export',
					jobId: index < 3 ? 'job-shared' : 'job-other',
					name: index < 2 ? 'shared-name' : `run-${index}`,
				}),
			},
			status: index === 1 ? 'error' : 'success',
			error: index === 1 ? new Error('fail') : undefined,
		})
	}
	const ids = async (input: Parameters<typeof listRunRecords>[0]) =>
		(await listRunRecords(input)).runs.map((run) => run.id)

	expect(await ids({ env, userId, filter: { surface: 'job' } })).toEqual([
		'run-4',
		'run-2',
		'run-0',
	])
	expect(await ids({ env, userId, filter: { status: 'error' } })).toEqual([
		'run-1',
	])
	expect(await ids({ env, userId, filter: { jobId: 'job-shared' } })).toEqual([
		'run-2',
		'run-1',
		'run-0',
	])
	expect(await ids({ env, userId, filter: { name: 'shared-name' } })).toEqual([
		'run-1',
		'run-0',
	])
	expect(
		await ids({
			env,
			userId,
			filter: { since: new Date(startedAtBase + 3000).toISOString() },
		}),
	).toEqual(['run-4', 'run-3'])

	const page1 = await listRunRecords({ env, userId, limit: 2 })
	expect(page1.runs.map((run) => run.id)).toEqual(['run-4', 'run-3'])
	expect(page1.nextCursor).toBeTruthy()
	const page2 = await listRunRecords({
		env,
		userId,
		limit: 2,
		cursor: page1.nextCursor,
	})
	expect(page2.runs.map((run) => run.id)).toEqual(['run-2', 'run-1'])
	const page3 = await listRunRecords({
		env,
		userId,
		limit: 2,
		cursor: page2.nextCursor,
	})
	expect(page3.runs.map((run) => run.id)).toEqual(['run-0'])
	expect(page3.nextCursor).toBeNull()
	// Another user's partition is invisible.
	expect(
		(await listRunRecords({ env, userId: uniqueUserId('other') })).runs,
	).toEqual([])
})

test('summarizeRunRecords returns totals and per-surface error counts', async () => {
	const userId = uniqueUserId('summarize')
	const startedAtBase = Date.now() - 60_000
	const cases: Array<{ surface: RunSurface; status: 'success' | 'error' }> = [
		{ surface: 'job', status: 'success' },
		{ surface: 'job', status: 'error' },
		{ surface: 'job', status: 'error' },
		{ surface: 'export', status: 'success' },
		{ surface: 'export', status: 'error' },
	]
	for (const [index, entry] of cases.entries()) {
		await finishRunRecord({
			env,
			handle: {
				id: crypto.randomUUID(),
				userId,
				startedAt: new Date(startedAtBase + index * 1000).toISOString(),
				persistence: 'eager',
				context: baseContext({ surface: entry.surface, name: `s-${index}` }),
			},
			status: entry.status,
			error: entry.status === 'error' ? new Error('x') : undefined,
		})
	}
	expect(
		await summarizeRunRecords({
			env,
			userId,
			since: new Date(startedAtBase - 1_000).toISOString(),
		}),
	).toEqual({
		since: new Date(startedAtBase - 1_000).toISOString(),
		total: 5,
		errors: 3,
		ignored: 0,
		resolved: 0,
		running: 0,
		bySurface: [
			{ surface: 'export', total: 2, errors: 1 },
			{ surface: 'job', total: 3, errors: 2 },
		],
	})
})

test('later job success soft-resolves prior open errors for only that job', async () => {
	const userId = uniqueUserId('auto-resolve-job')
	const baseMs = Date.now() - 60_000
	const finish = async (input: {
		id: string
		jobId: string
		status: 'success' | 'error'
		error?: Error
		offset: number
	}) => {
		await finishRunRecord({
			env,
			handle: {
				id: input.id,
				userId,
				startedAt: new Date(baseMs + input.offset).toISOString(),
				persistence: 'eager',
				context: baseContext({
					surface: 'job',
					jobId: input.jobId,
					name: 'recurring-job',
				}),
			},
			status: input.status,
			error: input.error,
		})
	}

	await finish({
		id: 'same-job-open',
		jobId: 'job-a',
		status: 'error',
		error: new Error('first failure'),
		offset: 0,
	})
	await finish({
		id: 'same-job-ignored',
		jobId: 'job-a',
		status: 'error',
		error: new Error('known noise'),
		offset: 1,
	})
	await finish({
		id: 'other-job-open',
		jobId: 'job-b',
		status: 'error',
		error: new Error('still broken'),
		offset: 2,
	})
	expect(
		(
			await updateRunErrorTriage({
				env,
				userId,
				runId: 'same-job-ignored',
				errorTriage: 'ignored',
				triageNote: 'user chose to ignore',
			})
		).ok,
	).toBe(true)
	expect(
		await updateRunErrorTriage({
			env,
			userId,
			runId: 'missing',
			errorTriage: 'ignored',
		}),
	).toEqual({ ok: false, reason: 'not_found' })

	await finish({
		id: 'same-job-success',
		jobId: 'job-a',
		status: 'success',
		offset: 3,
	})
	expect(
		await updateRunErrorTriage({
			env,
			userId,
			runId: 'same-job-success',
			errorTriage: 'ignored',
		}),
	).toEqual({
		ok: false,
		reason: 'not_error',
		status: 'success',
		runId: 'same-job-success',
	})

	const all = await listRunRecords({
		env,
		userId,
		filter: { errorTriage: 'all' },
		limit: 10,
	})
	const byId = new Map(all.runs.map((run) => [run.id, run]))
	expect(byId.get('same-job-open')).toMatchObject({
		status: 'error',
		errorMessage: 'first failure',
		errorTriage: 'resolved',
		triageNote: 'auto-resolved: later success of the same job',
		triagedBy: 'system:auto-resolve',
	})
	expect(byId.get('same-job-ignored')).toMatchObject({
		status: 'error',
		errorTriage: 'ignored',
		triageNote: 'user chose to ignore',
		triagedBy: userId,
	})
	expect(byId.get('other-job-open')).toMatchObject({
		status: 'error',
		errorTriage: null,
	})
	expect(byId.get('same-job-success')).toMatchObject({
		status: 'success',
		errorTriage: null,
	})
	expect(
		(
			await listRunRecords({ env, userId, filter: { errorTriage: 'open' } })
		).runs.map((run) => run.id),
	).toEqual(['same-job-success', 'other-job-open'])
	expect(await summarizeRunRecords({ env, userId })).toMatchObject({
		total: 4,
		errors: 1,
		ignored: 1,
		resolved: 1,
	})
})

test('bulk triage honors the public limit of 100 across write paths', async () => {
	const runScenario = async (limit: number) => {
		const userId = uniqueUserId(`bulk-triage-${limit}`)
		const jobId = `exact-job-${limit}`
		const runIds = Array.from(
			{ length: limit },
			(_, index) => `bulk-${limit}-${index}`,
		)
		const store = seeder.forUser(userId)
		for (const [index, id] of runIds.entries()) {
			await seedRun(store, {
				id,
				status: 'error',
				startedAt: new Date(Date.now() - index).toISOString(),
				jobId,
				errorMessage: 'reproducible failure',
			})
		}

		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				filter: { jobId },
				errorTriage: 'resolved',
				triageNote: 'production cleanup',
				limit,
				dryRun: true,
			}),
		).resolves.toMatchObject({
			matchedRunIds: expect.arrayContaining([`bulk-${limit}-0`]),
			updatedCount: 0,
			hasMore: false,
		})
		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				filter: { jobId },
				errorTriage: 'resolved',
				triageNote: 'production cleanup',
				limit,
			}),
		).resolves.toMatchObject({ updatedCount: limit, hasMore: false })
		const resolved = await listRunRecords({
			env,
			userId,
			filter: { jobId, errorTriage: 'resolved' },
			limit,
		})
		expect(resolved.runs).toHaveLength(limit)
		expect(
			resolved.runs.every(
				(run) =>
					run.errorTriage === 'resolved' &&
					run.triageNote === 'production cleanup',
			),
		).toBe(true)

		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				filter: { jobId, errorTriage: 'resolved' },
				errorTriage: null,
				limit,
			}),
		).resolves.toMatchObject({ updatedCount: limit, hasMore: false })
		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				runIds,
				errorTriage: 'ignored',
				limit,
			}),
		).resolves.toMatchObject({ updatedCount: limit, hasMore: false })
		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				runIds,
				errorTriage: null,
				limit,
			}),
		).resolves.toMatchObject({ updatedCount: limit, hasMore: false })
		// Reopening already-open rows matches nothing.
		await expect(
			bulkUpdateRunErrorTriage({
				env,
				userId,
				runIds,
				errorTriage: null,
				limit,
			}),
		).resolves.toEqual({ matchedRunIds: [], updatedCount: 0, hasMore: false })

		const reopened = await listRunRecords({
			env,
			userId,
			filter: { jobId, errorTriage: 'open' },
			limit,
		})
		expect(reopened.runs).toHaveLength(limit)
		expect(reopened.runs.every((run) => run.errorTriage === null)).toBe(true)
	}

	await runScenario(25)
	await runScenario(100)
})

test('bulk triage is all-or-nothing when a selected row changes before the write', async () => {
	const userId = uniqueUserId('bulk-triage-atomic')
	const jobId = 'atomic-job'
	const store = seeder.forUser(userId)
	for (let index = 0; index < 100; index += 1) {
		await seedRun(store, {
			id: `atomic-${index}`,
			status: 'error',
			startedAt: new Date(Date.now() - index).toISOString(),
			jobId,
			errorMessage: 'atomic failure fixture',
		})
	}
	// A late success lands on one selected row between selection and write.
	const racing = runRecords.reopen({
		send: async (command) => {
			if (command.constructor.name === 'TransactWriteItemsCommand') {
				const item = runRecords.dynamo
					.items(runRecords.tableName)
					.find((candidate) => candidate.id?.S === 'atomic-99')!
				runRecords.dynamo.putItem(runRecords.tableName, {
					...item,
					status: { S: 'success' },
				})
			}
			return await runRecords.dynamo.send(command)
		},
	})
	await expect(
		racing.forUser(userId).bulkUpdateRunErrorTriage({
			runIds: null,
			filter: { jobId },
			errorTriage: 'resolved',
			preserveTriageNote: true,
			triageNote: null,
			triagedBy: userId,
			limit: 100,
			dryRun: false,
		}),
	).rejects.toMatchObject({ name: 'TransactionCanceledException' })
	expect(storedRuns(userId).filter((run) => run.errorTriage != null)).toEqual(
		[],
	)
})

test('cap and stale retention journey', async () => {
	// --- handled duplicate errors are deleted before successes and open errors ---
	{
		const userId = uniqueUserId('retention-priority')
		const store = seeder.forUser(userId)
		const baseMs = Date.now() - 3_600_000
		const triagedErrorCount = runRecordMaxRunsPerUser - 20
		const successCount = 20
		const openErrorCount = 10
		for (let index = 0; index < triagedErrorCount; index += 1) {
			await seedRun(store, {
				id: `duplicate-error-${index}`,
				status: 'error',
				startedAt: new Date(baseMs + index).toISOString(),
				errorMessage: 'same recurring failure',
				errorTriage: 'resolved',
			})
		}
		for (let index = 0; index < successCount; index += 1) {
			await seedRun(store, {
				id: `success-${index}`,
				status: 'success',
				startedAt: new Date(baseMs + triagedErrorCount + index).toISOString(),
			})
		}
		for (let index = 0; index < openErrorCount; index += 1) {
			await seedRun(store, {
				id: `open-error-${index}`,
				status: 'error',
				startedAt: new Date(
					baseMs + triagedErrorCount + successCount + index,
				).toISOString(),
				errorMessage: 'still broken',
			})
		}
		const seeded = triagedErrorCount + successCount + openErrorCount
		await finishRunRecord({
			env: retentionEnv,
			handle: {
				id: 'retention-trigger',
				userId,
				startedAt: new Date(baseMs + seeded + 20).toISOString(),
				persistence: 'eager',
				context: baseContext({ surface: 'job', name: 'trigger' }),
			},
			status: 'success',
		})
		const summary = await summarizeRunRecords({ env, userId })
		expect(summary.total).toBe(runRecordMaxRunsPerUser)
		expect(summary.errors).toBe(openErrorCount)
		const runs = storedRuns(userId)
		expect({
			successes: runs.filter((run) => run.status === 'success').length,
			triagedErrors: runs.filter(
				(run) => run.status === 'error' && run.errorTriage != null,
			).length,
			openErrors: runs.filter(
				(run) => run.status === 'error' && run.errorTriage == null,
			).length,
		}).toEqual({
			successes: successCount + 1,
			triagedErrors:
				runRecordMaxRunsPerUser - successCount - openErrorCount - 1,
			openErrors: openErrorCount,
		})
		expect(runs.some((run) => run.id === 'duplicate-error-0')).toBe(false)
	}

	// --- cap eviction never deletes in-flight running rows ---
	{
		const userId = uniqueUserId('cap-protect-running')
		const store = seeder.forUser(userId)
		const baseMs = Date.now() - 3_600_000
		const successCount = 2
		const errorCount = runRecordMaxRunsPerUser
		for (let index = 0; index < successCount; index += 1) {
			await seedRun(store, {
				id: `success-${index}`,
				status: 'success',
				startedAt: new Date(baseMs + index).toISOString(),
			})
		}
		await seedRun(store, {
			id: 'still-running',
			status: 'running',
			startedAt: new Date(baseMs + successCount).toISOString(),
		})
		for (let index = 0; index < errorCount; index += 1) {
			await seedRun(store, {
				id: `error-${index}`,
				status: 'error',
				startedAt: new Date(baseMs + successCount + 1 + index).toISOString(),
			})
		}
		const seeded = successCount + 1 + errorCount
		await finishRunRecord({
			env: retentionEnv,
			handle: {
				id: 'cap-running-trigger',
				userId,
				startedAt: new Date(baseMs + seeded + 10).toISOString(),
				persistence: 'eager',
				context: baseContext({ surface: 'job', name: 'cap-running-trigger' }),
			},
			status: 'success',
		})
		expect(
			(await getRunRecord({ env, userId, runId: 'still-running' }))?.run.status,
		).toBe('running')
		// Excess was 4: 3 successes (2 seeded + trigger) then 1 oldest error.
		const runs = storedRuns(userId)
		expect(runs.filter((run) => run.status === 'success')).toEqual([])
		expect(runs.filter((run) => run.status === 'running')).toHaveLength(1)
		expect(runs.some((run) => run.id === 'error-0')).toBe(false)
		expect(runs.filter((run) => run.status === 'error')).toHaveLength(
			errorCount - 1,
		)
	}

	// --- the cap pass reconciles stale running rows; fresh running preserved ---
	{
		const userId = uniqueUserId('stale-running')
		const store = seeder.forUser(userId)
		await seedRun(store, {
			id: 'stale-running',
			status: 'running',
			startedAt: new Date(
				Date.now() - runRecordStaleRunningTtlMsJob - 60_000,
			).toISOString(),
		})
		await seedRun(store, {
			id: 'fresh-running',
			status: 'running',
			startedAt: new Date().toISOString(),
		})
		await finishRunRecord({
			env: retentionEnv,
			handle: {
				id: 'stale-trigger',
				userId,
				startedAt: new Date().toISOString(),
				persistence: 'eager',
				context: baseContext({ surface: 'job', name: 'stale-trigger' }),
			},
			status: 'success',
		})
		// Healed in the table by the cap pass, before any read.
		expect(
			storedRuns(userId).find((run) => run.id === 'stale-running')?.status,
		).toBe('error')
		const stale = await getRunRecord({ env, userId, runId: 'stale-running' })
		expect(stale?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			errorMessage:
				'The platform interrupted this run before completion; outcome unknown.',
			errorTriage: null,
		})
		expect(stale?.run.finishedAt).toBeTruthy()
		const fresh = await getRunRecord({ env, userId, runId: 'fresh-running' })
		expect(fresh?.run).toMatchObject({ status: 'running', finishedAt: null })
	}

	// --- execute-surface stale rows heal on read within minutes, not 24h ---
	{
		const userId = uniqueUserId('stale-execute-heal')
		await seedRun(seeder.forUser(userId), {
			id: 'stale-execute',
			status: 'running',
			surface: 'execute',
			startedAt: new Date(
				Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
			).toISOString(),
		})
		expect(
			await listRunRecords({ env, userId, filter: { status: 'running' } }),
		).toEqual({ runs: [], nextCursor: null })
		const healed = await getRunRecord({ env, userId, runId: 'stale-execute' })
		expect(healed?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			surface: 'execute',
		})
	}

	// --- idempotent scheduled/queued runs retain auto-ignored interrupt history ---
	{
		const userId = uniqueUserId('idempotent-platform-interrupt')
		const store = seeder.forUser(userId)
		const staleJobStartedAt = new Date(
			Date.now() - runRecordStaleRunningTtlMsJob - 1_000,
		).toISOString()
		const staleShortStartedAt = new Date(
			Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
		).toISOString()
		await seedRun(store, {
			id: 'stale-scheduled-job',
			status: 'running',
			startedAt: staleJobStartedAt,
			surface: 'job',
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
		})
		await seedRun(store, {
			id: 'stale-subscription-delivery',
			status: 'running',
			startedAt: staleShortStartedAt,
			surface: 'subscription',
			idempotencyKey: 'delivery-123',
		})
		await seedRun(store, {
			id: 'stale-keyed-export',
			status: 'running',
			startedAt: staleShortStartedAt,
			surface: 'export',
			idempotencyKey: 'youtube:websub:video-1:2026-08-25T13:41:52.301Z',
		})

		const page = await listRunRecords({
			env,
			userId,
			filter: { errorTriage: 'all' },
		})
		expect(page.runs).toHaveLength(3)
		for (const run of page.runs) {
			expect(run).toMatchObject({
				status: 'error',
				errorName: runRecordPlatformInterruptedErrorName,
				errorTriage: 'ignored',
				triagedBy: 'system:platform-interrupt',
			})
		}
		expect(
			await summarizeRunRecords({
				env,
				userId,
				since: new Date(0).toISOString(),
			}),
		).toMatchObject({ errors: 0, ignored: 3, running: 0 })
		expect(
			(
				await listRunRecords({
					env,
					userId,
					filter: { errorTriage: 'ignored' },
				})
			).runs,
		).toHaveLength(3)

		await finishRunRecord({
			env,
			handle: {
				id: 'stale-scheduled-job',
				userId,
				startedAt: staleJobStartedAt,
				persistence: 'eager',
				context: baseContext({
					surface: 'job',
					idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
				}),
			},
			status: 'error',
			error: new Error('package failed after the delayed finish arrived'),
		})
		expect(
			(await getRunRecord({ env, userId, runId: 'stale-scheduled-job' }))?.run,
		).toMatchObject({
			status: 'error',
			errorName: 'Error',
			errorMessage: 'package failed after the delayed finish arrived',
			errorTriage: null,
			triageNote: null,
			triagedAt: null,
			triagedBy: null,
		})
		for (const runId of ['stale-subscription-delivery', 'stale-keyed-export']) {
			expect((await getRunRecord({ env, userId, runId }))?.run).toMatchObject({
				errorName: runRecordPlatformInterruptedErrorName,
				errorTriage: 'ignored',
			})
		}
	}

	// --- a real late finish replaces reconciled platform interrupt ---
	{
		const userId = uniqueUserId('late-finish-after-interrupted')
		const staleStartedAt = new Date(
			Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
		).toISOString()
		const handle = {
			id: 'late-finish-after-interrupted',
			userId,
			startedAt: staleStartedAt,
			persistence: 'eager' as const,
			context: baseContext({ surface: 'export', name: './slow-export' }),
		}
		await seedRun(seeder.forUser(userId), {
			id: handle.id,
			status: 'running',
			startedAt: staleStartedAt,
			surface: 'export',
		})
		expect(
			(await getRunRecord({ env, userId, runId: handle.id }))?.run.errorName,
		).toBe(runRecordPlatformInterruptedErrorName)

		await finishRunRecord({
			env,
			handle,
			status: 'success',
			result: { completed: true },
		})
		const completed = await getRunRecord({ env, userId, runId: handle.id })
		expect(completed?.run).toMatchObject({
			status: 'success',
			errorName: null,
			metadata: { result: { completed: true } },
		})
	}

	// --- stale rows become cap-evictable after reconcile ---
	{
		const userId = uniqueUserId('stale-cap-evict')
		const store = seeder.forUser(userId)
		const baseMs = Date.now() - 3_600_000
		const staleStartedMs = Date.now() - runRecordStaleRunningTtlMsJob - 60_000
		const successCount = 2
		const errorCount = runRecordMaxRunsPerUser - 2
		const staleCount = 5
		for (let index = 0; index < successCount; index += 1) {
			await seedRun(store, {
				id: `success-${index}`,
				status: 'success',
				startedAt: new Date(baseMs + index).toISOString(),
			})
		}
		for (let index = 0; index < staleCount; index += 1) {
			await seedRun(store, {
				id: `stale-${index}`,
				status: 'running',
				startedAt: new Date(staleStartedMs + index).toISOString(),
			})
		}
		for (let index = 0; index < errorCount; index += 1) {
			await seedRun(store, {
				id: `error-${index}`,
				status: 'error',
				startedAt: new Date(baseMs + 10_000 + index).toISOString(),
			})
		}
		const seeded = successCount + staleCount + errorCount
		await finishRunRecord({
			env: retentionEnv,
			handle: {
				id: 'stale-cap-trigger',
				userId,
				startedAt: new Date(baseMs + seeded + 10).toISOString(),
				persistence: 'eager',
				context: baseContext({ surface: 'job', name: 'stale-cap-trigger' }),
			},
			status: 'success',
		})
		// Reconcile demotes stale running → interrupted errors (oldest
		// startedAt); the cap then drains successes and those errors first.
		expect(await getRunRecord({ env, userId, runId: 'stale-0' })).toBeNull()
		expect(
			storedRuns(userId).filter((run) => run.status === 'running'),
		).toEqual([])
	}

	// --- runs past the 30-day window disappear (DynamoDB TTL) ---
	{
		const userId = uniqueUserId('age-retention')
		const store = seeder.forUser(userId)
		await seedRun(store, {
			id: 'old-success',
			status: 'success',
			startedAt: new Date(
				Date.now() - (runRecordRetentionDays + 2) * 24 * 60 * 60 * 1000,
			).toISOString(),
		})
		await seedRun(store, {
			id: 'recent-success',
			status: 'success',
			startedAt: new Date(Date.now() - 60_000).toISOString(),
		})
		expect(
			(await listRunRecords({ env, userId })).runs.map((run) => run.id),
		).toEqual(['recent-success'])
		expect(await getRunRecord({ env, userId, runId: 'old-success' })).toBeNull()
		expect(
			(
				await summarizeRunRecords({
					env,
					userId,
					since: new Date(0).toISOString(),
				})
			).total,
		).toBe(1)
	}
})

test('package invocation runs share history with the ledger on the RunLog DO', async () => {
	const userId = uniqueUserId('package-finish')
	const runLog = createFakeRunLog()
	const packageEnv = {
		RUN_RECORDS: runRecords.records,
		RUN_STATE: runLog.state,
	} as unknown as Env
	const claimed = await claimPackageInvocationRecord({
		env: packageEnv,
		userId,
		context: {
			surface: 'export',
			packageId: 'pkg-memo',
			name: 'handler',
			idempotencyKey: 'evt-memo',
		},
		invocation: {
			id: crypto.randomUUID(),
			tokenId: 'token-memo',
			packageId: 'pkg-memo',
			packageKodyId: 'kody-memo',
			exportName: 'handler',
			idempotencyKey: 'evt-memo',
			requestHash: 'hash-memo',
			source: null,
			topic: null,
		},
		staleBefore: new Date(0).toISOString(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('expected claim')
	const since = new Date(0).toISOString()
	expect(await summarizeRunRecords({ env, userId, since })).toMatchObject({
		running: 1,
	})
	const running = await getRunRecord({
		env,
		userId,
		runId: claimed.handle!.id,
	})
	expect(running?.run.invocationId).toBe(claimed.invocationId)
	expect(running?.logs.map((line) => line.message)).toEqual([
		'package invocation started: handler',
	])
	const finished = await finishPackageInvocationRecord({
		env: packageEnv,
		userId,
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: JSON.stringify({ ok: true }),
		status: 'success',
		logs: ['handled'],
	})
	expect(finished.ledgerUpdated).toBe(true)
	expect(runLog.ledgerRows).toMatchObject([
		{ idempotencyKey: 'evt-memo', status: 'completed' },
	])
	expect(await summarizeRunRecords({ env, userId, since })).toMatchObject({
		total: 1,
		running: 0,
	})
	expect(
		(await getRunRecord({ env, userId, runId: claimed.handle!.id }))?.logs.map(
			(line) => line.message,
		),
	).toEqual(['handled'])
})

test('run recording degrades to a warning instead of failing the observed run', async () => {
	consoleWarn.mockImplementation(() => {})
	const userId = uniqueUserId('never-throws')
	expect(
		beginRunRecord({
			env,
			userId,
			context: baseContext({ surface: 'not-a-surface' as RunSurface }),
		}),
	).toBeNull()

	// Finish still lands even when begin was refused.
	await finishRunRecord({
		env,
		handle: {
			id: crypto.randomUUID(),
			userId,
			startedAt: new Date().toISOString(),
			persistence: 'eager',
			context: baseContext({
				surface: 'subscription',
				name: 'email.message.received',
				packageId: 'package-1',
			}),
		},
		status: 'success',
	})
	expect(consoleWarn.mock.calls.map(([message]) => message)).toEqual([
		'run-record-begin-failed',
	])
	const page = await listRunRecords({ env, userId })
	expect(page.runs).toHaveLength(1)
	expect(page.runs[0]?.status).toBe('success')

	// No run store: recording is skipped, never thrown.
	expect(
		beginRunRecord({ env: {} as Env, userId, context: baseContext() }),
	).toBeNull()
	expect(await listRunRecords({ env: {} as Env, userId })).toEqual({
		runs: [],
		nextCursor: null,
	})
})

test('clearRunRecords empties the user partition and its log objects', async () => {
	const userId = uniqueUserId('clear')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({
			surface: 'retriever',
			storageId: 'storage-1',
			jobId: 'job-clear',
			packageId: 'pkg-clear',
		}),
	})
	await finishRunRecord({ env, handle, status: 'success', logs: ['keep me'] })
	expect((await listRunRecords({ env, userId })).runs).toHaveLength(1)
	await clearRunRecords({ env, userId })
	expect(await listRunRecords({ env, userId })).toEqual({
		runs: [],
		nextCursor: null,
	})
	expect(await getRunRecord({ env, userId, runId: handle!.id })).toBeNull()
	expect(
		runRecords.dynamo
			.items(runRecords.tableName)
			.filter((item) => item.pk?.S === userId),
	).toEqual([])
	expect(
		[...runRecords.logs.objects.keys()].some((key) => key.includes(userId)),
	).toBe(false)
})

test('keyed execute claims eagerly, retains bounded result, and replays without a second claim', async () => {
	const userId = uniqueUserId('keyed-execute')
	const key = `execute-key-${crypto.randomUUID()}`
	const first = await claimRunRecord({
		env,
		userId,
		context: {
			surface: 'execute',
			name: null,
			idempotencyKey: key,
			metadata: { conversationId: 'conv-keyed' },
		},
	})
	if (!first || !first.claimed) throw new Error('expected claim')
	expect(first.handle.persistence).toBe('eager')

	expect(
		await claimRunRecord({
			env,
			userId,
			context: { surface: 'execute', idempotencyKey: key },
		}),
	).toEqual({
		claimed: false,
		run: expect.objectContaining({
			id: first.handle.id,
			status: 'running',
			idempotencyKey: key,
		}),
	})

	const oversized = {
		blob: 'x'.repeat(runRecordMaxResultSnapshotBytes + 512),
	}
	await finishRunRecord({
		env,
		handle: first.handle,
		status: 'success',
		result: oversized,
		logs: ['done'],
	})
	const byKey = await getRunRecordByIdempotencyKey({
		env,
		userId,
		idempotencyKey: key,
		surface: 'execute',
	})
	expect(byKey).toMatchObject({ id: first.handle.id, status: 'success' })
	expect(byKey?.metadata['result']).toEqual(
		expect.objectContaining({
			__truncated__: true,
			preview: expect.any(String),
		}),
	)
	expect(
		await claimRunRecord({
			env,
			userId,
			context: { surface: 'execute', idempotencyKey: key },
		}),
	).toEqual({
		claimed: false,
		run: expect.objectContaining({ id: first.handle.id, status: 'success' }),
	})

	// Concurrent claims of a fresh key: exactly one wins.
	const raceKey = `race-${crypto.randomUUID()}`
	const raced = await Promise.all(
		Array.from({ length: 5 }, () =>
			claimRunRecord({
				env,
				userId,
				context: { surface: 'execute', idempotencyKey: raceKey },
			}),
		),
	)
	expect(raced.filter((claim) => claim?.claimed)).toHaveLength(1)

	// Key-less execute success is retained the same way, without a replay key.
	const keyless = beginRunRecord({
		env,
		userId,
		context: { surface: 'execute', name: 'keyless-ok' },
	})
	expect(keyless?.persistence).toBe('eager')
	await finishRunRecord({
		env,
		handle: keyless,
		status: 'success',
		result: { kept: true },
	})
	expect(
		(await getRunRecord({ env, userId, runId: keyless!.id }))?.run,
	).toMatchObject({
		status: 'success',
		idempotencyKey: null,
		metadata: { result: { kept: true } },
	})
})

test('idempotency lookup is surface-scoped and abandon releases running claims', async () => {
	const userId = uniqueUserId('surface-key')
	const sharedKey = `shared-key-${crypto.randomUUID()}`
	await recordRunRecord({
		env,
		userId,
		context: { surface: 'workflow', name: 'wf', idempotencyKey: sharedKey },
		status: 'success',
		result: { from: 'workflow' },
	})
	const executeClaim = await claimRunRecord({
		env,
		userId,
		context: { surface: 'execute', idempotencyKey: sharedKey },
	})
	if (!executeClaim || !executeClaim.claimed) throw new Error('expected claim')
	const lookup = (surface: RunSurface) =>
		getRunRecordByIdempotencyKey({
			env,
			userId,
			idempotencyKey: sharedKey,
			surface,
		})
	expect(await lookup('execute')).toMatchObject({
		id: executeClaim.handle.id,
		surface: 'execute',
	})

	await abandonRunRecord({ env, handle: executeClaim.handle })
	expect(await lookup('execute')).toBeNull()
	expect((await lookup('workflow'))?.metadata['result']).toEqual({
		from: 'workflow',
	})
	// The released key can be claimed again.
	expect(
		(
			await claimRunRecord({
				env,
				userId,
				context: { surface: 'execute', idempotencyKey: sharedKey },
			})
		)?.claimed,
	).toBe(true)
})

test('snapshotRunRecordResult keeps small values and marks oversized ones', () => {
	expect(snapshotRunRecordResult({ ok: true, agentId: 'abc' })).toEqual({
		ok: true,
		agentId: 'abc',
	})
	const huge = 'y'.repeat(runRecordMaxResultSnapshotBytes + 100)
	expect(snapshotRunRecordResult({ payload: huge })).toEqual({
		__truncated__: true,
		preview: expect.stringContaining('... [truncated]'),
	})
})

test('webhook/export finish retains metadata.result for runGet', async () => {
	const userId = uniqueUserId('result-snapshot')
	const handle = await recordRunRecord({
		env,
		userId,
		context: {
			surface: 'webhook',
			name: 'sentry',
			metadata: {
				endpointId: 'ep-1',
				httpStatus: 202,
				outcome: 'delivered',
			},
		},
		status: 'success',
		result: { skipped: 'other-project' },
	})
	const detail = await getRunRecord({ env, userId, runId: handle!.id })
	expect(detail?.run.metadata).toMatchObject({
		endpointId: 'ep-1',
		outcome: 'delivered',
		result: { skipped: 'other-project' },
	})
})
