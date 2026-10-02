import { expect, test, vi } from 'vitest'
import { createFakeRunLog } from '#worker/test-support/package-invocations.ts'
import {
	createRunRow,
	createTestRunRecords,
} from '#worker/test-support/run-records.ts'
import { type PackageInvocationLedgerRecord } from './run-state-types.ts'
import {
	beginRunRecord,
	claimPackageInvocationRecord,
	clearRunRecords,
	exportRunRecords,
	finishPackageInvocationRecord,
	finishRunRecord,
	getAdminInsightsSnapshot,
	getJobRunObservability,
	getJobRunObservabilityBatch,
	listActivationMilestones,
	listPackageRunSuccesses,
	listRunRecords,
	upsertJobRunObservability,
	type WorkflowProjectionRecord,
} from './service.ts'
import {
	runRecordMaxRunsPerUser,
	runRecordRetentionDays,
	type RunRecordContext,
} from './types.ts'

// Run-error subscription fan-out reads APP_DB; it has its own suite.
vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
}))

const runRecords = createTestRunRecords()
const env = runRecords.env as unknown as Env
const retentionEnv = {
	RUN_RECORDS: runRecords.reopen({ retentionEveryNFinishes: 1 }),
} as unknown as Env
const seeder = runRecords.reopen({
	retentionEveryNFinishes: Number.POSITIVE_INFINITY,
})

function uniqueUserId(label: string) {
	return `runlog-dedicated-${label}-${crypto.randomUUID()}`
}

function projection(id: string, status: string): WorkflowProjectionRecord {
	const at = '2026-07-31T00:00:00.000Z'
	return {
		id,
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline',
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: `secret-name-${id}`,
		exportName: null,
		idempotencyKey: `idem-${id}`,
		runAt: at,
		planDate: null,
		status,
		createdAt: at,
		updatedAt: at,
		completedAt: null,
		lastError: 'secret-error-must-not-leak',
	}
}

/**
 * The RunLog DO's remaining export phases (ledger, then projections) and its
 * workflow status counts, over fixed rows. The DO's own paging is covered by
 * its Workers suite until P5 retires it.
 */
function legacyRunLog(rows: {
	packageInvocations?: Array<PackageInvocationLedgerRecord>
	workflowProjections?: Array<WorkflowProjectionRecord>
}) {
	return {
		forUser: () => ({
			async exportState() {
				return {
					packageInvocations: rows.packageInvocations ?? [],
					workflowProjections: rows.workflowProjections ?? [],
				}
			},
			async clear() {
				rows.packageInvocations = []
				rows.workflowProjections = []
			},
		}),
	}
}

test('job run observability upserts terminal outcomes and supports batch reads', async () => {
	const userId = uniqueUserId('jobs')
	expect(
		await upsertJobRunObservability({
			env,
			userId,
			outcome: {
				jobId: 'job-a',
				status: 'success',
				ranAt: '2026-07-31T10:00:00.000Z',
				durationMs: 120,
			},
		}),
	).toEqual({
		jobId: 'job-a',
		lastRunAt: '2026-07-31T10:00:00.000Z',
		lastRunStatus: 'success',
		lastRunError: null,
		lastDurationMs: 120,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		updatedAt: '2026-07-31T10:00:00.000Z',
	})
	expect(
		await upsertJobRunObservability({
			env,
			userId,
			outcome: {
				jobId: 'job-a',
				status: 'error',
				ranAt: '2026-07-31T11:00:00.000Z',
				error: 'boom',
				durationMs: 40,
			},
		}),
	).toMatchObject({
		lastRunAt: '2026-07-31T11:00:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'boom',
		lastDurationMs: 40,
		runCount: 2,
		successCount: 1,
		errorCount: 1,
	})
	// A later success clears the stored error and an absent duration.
	expect(
		await upsertJobRunObservability({
			env,
			userId,
			outcome: {
				jobId: 'job-a',
				status: 'success',
				ranAt: '2026-07-31T11:30:00.000Z',
			},
		}),
	).toMatchObject({ lastRunError: null, lastDurationMs: null, runCount: 3 })
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-b',
			status: 'success',
			ranAt: '2026-07-31T12:00:00.000Z',
			durationMs: 10,
		},
	})
	expect(
		(
			await getJobRunObservabilityBatch({
				env,
				userId,
				jobIds: ['job-b', 'job-a', 'missing', ' job-a '],
			})
		).map((row) => row.jobId),
	).toEqual(['job-a', 'job-b'])
	expect(
		await getJobRunObservability({
			env,
			userId: uniqueUserId('other'),
			jobId: 'job-a',
		}),
	).toBeNull()
})

test('finishRun updates job observability from zero for success/error and ignores replay', async () => {
	const userId = uniqueUserId('jobs-finish')
	const successHandle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'daily',
			jobId: 'job-finish',
			packageId: 'pkg-job',
		},
	})
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['ok'],
	})
	const afterSuccess = await getJobRunObservability({
		env,
		userId,
		jobId: 'job-finish',
	})
	expect(afterSuccess).toMatchObject({
		jobId: 'job-finish',
		lastRunStatus: 'success',
		lastRunError: null,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
	})
	expect(afterSuccess?.lastDurationMs).toBeGreaterThanOrEqual(0)

	// Replayed terminal finish of the same run must not double-count.
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['replay'],
	})
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-finish' }),
	).toMatchObject({ runCount: 1, successCount: 1, errorCount: 0 })

	const errorHandle = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'daily', jobId: 'job-finish' },
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('job blew up'),
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('job blew up again'),
	})
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-finish' }),
	).toMatchObject({
		lastRunStatus: 'error',
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		// Replay keeps the first terminal error message.
		lastRunError: 'job blew up',
	})

	// Without jobId, finish must not invent observability rows.
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: { surface: 'job', name: 'no-job-id', packageId: 'pkg-job' },
		}),
		status: 'success',
	})
	expect(
		runRecords.dynamo
			.items(runRecords.tableName)
			.filter((item) => item.pk?.S === userId && item.sk?.S?.startsWith('job#'))
			.map((item) => item.sk?.S),
	).toEqual(['job#job-finish'])
})

test('activation counts same-package successes, excludes HTTP surfaces, and is idempotent on replay', async () => {
	const userId = uniqueUserId('activation')
	async function finishSuccess(input: {
		packageId: string
		surface: RunRecordContext['surface']
	}) {
		const handle = beginRunRecord({
			env,
			userId,
			context: {
				surface: input.surface,
				name: `${input.surface}-${input.packageId}`,
				packageId: input.packageId,
			},
		})
		await finishRunRecord({ env, handle, status: 'success', logs: ['ok'] })
		return handle!
	}
	const successes = async () =>
		(await listPackageRunSuccesses({ env, userId })).map(
			(row) => [row.packageId, row.successCount] as const,
		)
	const milestones = async () =>
		(await listActivationMilestones({ env, userId })).map(
			(row) => [row.milestone, row.packageId] as const,
		)

	const first = await finishSuccess({ packageId: 'pkg-a', surface: 'job' })
	expect(await successes()).toEqual([['pkg-a', 1]])
	expect(await milestones()).toEqual([['package_run_succeeded', 'pkg-a']])
	await finishRunRecord({ env, handle: first, status: 'success' })
	expect(await successes()).toEqual([['pkg-a', 1]])

	await finishSuccess({ packageId: 'pkg-b', surface: 'subscription' })
	await finishSuccess({ packageId: 'pkg-a', surface: 'webhook' })
	await finishSuccess({ packageId: 'pkg-a', surface: 'app_fetch' })
	expect(await successes()).toEqual([
		['pkg-a', 1],
		['pkg-b', 1],
	])
	// The first success keeps its milestone timestamp and package.
	expect(await milestones()).toEqual([['package_run_succeeded', 'pkg-a']])

	await finishSuccess({ packageId: 'pkg-a', surface: 'workflow' })
	expect(await successes()).toEqual([
		['pkg-a', 2],
		['pkg-b', 1],
	])
	expect(await milestones()).toEqual([
		['package_activated', 'pkg-a'],
		['package_run_succeeded', 'pkg-a'],
	])

	// Global package_activated latch: further successes change nothing.
	await finishSuccess({ packageId: 'pkg-a', surface: 'job' })
	await finishSuccess({ packageId: 'pkg-b', surface: 'job' })
	await finishSuccess({ packageId: 'pkg-c', surface: 'workflow' })
	expect(await successes()).toEqual([
		['pkg-a', 2],
		['pkg-b', 1],
	])

	// Keyed package invocation finish also activates once.
	const claimUser = uniqueUserId('activation-invoke')
	const invokeEnv = {
		...env,
		RUN_STATE: createFakeRunLog().state,
	} as unknown as Env
	const claimed = await claimPackageInvocationRecord({
		env: invokeEnv,
		userId: claimUser,
		context: {
			surface: 'export',
			packageId: 'pkg-invoke',
			name: 'handler',
			idempotencyKey: 'evt-1',
		},
		invocation: {
			id: crypto.randomUUID(),
			tokenId: 'token-1',
			packageId: 'pkg-invoke',
			packageKodyId: 'kody-invoke',
			exportName: 'handler',
			idempotencyKey: 'evt-1',
			requestHash: 'hash-1',
			source: null,
			topic: null,
		},
		staleBefore: new Date(0).toISOString(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('expected claim')
	const finish = () =>
		finishPackageInvocationRecord({
			env: invokeEnv,
			userId: claimUser,
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson: JSON.stringify({ ok: true }),
			status: 'success',
		})
	expect((await finish()).ledgerUpdated).toBe(true)
	expect((await finish()).ledgerUpdated).toBe(false)
	expect(await listPackageRunSuccesses({ env, userId: claimUser })).toEqual([
		expect.objectContaining({ packageId: 'pkg-invoke', successCount: 1 }),
	])
})

test('concurrent finishes of one package each count once; a failed finish writes nothing', async () => {
	const userId = uniqueUserId('activation-concurrent')
	await Promise.all(
		['a', 'b', 'c'].map((suffix) =>
			finishRunRecord({
				env,
				handle: beginRunRecord({
					env,
					userId,
					context: {
						surface: 'job',
						name: `concurrent-${suffix}`,
						packageId: 'pkg-race',
						jobId: 'job-race',
					},
				}),
				status: 'success',
			}),
		),
	)
	// The first two successes activate; the latch then freezes the counter.
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-race', successCount: 2 }),
	])
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-race' }),
	).toMatchObject({ runCount: 3, successCount: 3 })

	// The run row and its counters commit in one transaction.
	const failing = runRecords
		.reopen({
			send: async (command) => {
				if (command.constructor.name === 'TransactWriteItemsCommand') {
					throw Object.assign(new Error('service unavailable'), {
						name: 'InternalServerError',
					})
				}
				return await runRecords.dynamo.send(command)
			},
		})
		.forUser(userId)
	await expect(
		failing.finishRun({
			run: createRunRow({
				id: 'tx-fail',
				surface: 'job',
				status: 'success',
				packageId: 'pkg-tx',
				jobId: 'job-tx',
				finishedAt: new Date().toISOString(),
			}),
			logs: [],
		}),
	).rejects.toThrow('service unavailable')
	const keys = runRecords.dynamo
		.items(runRecords.tableName)
		.filter((item) => item.pk?.S === userId)
		.map((item) => item.sk!.S!)
	expect(keys).not.toContain('run#tx-fail')
	expect(keys).not.toContain('job#job-tx')
	expect(keys).not.toContain('pkg#pkg-tx')
})

test('retention prunes runs but never job or activation state', async () => {
	const userId = uniqueUserId('retention')
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-keep',
			status: 'success',
			ranAt: new Date().toISOString(),
			durationMs: 5,
		},
	})
	const store = seeder.forUser(userId)
	const agedStartedAt = new Date(
		Date.now() - (runRecordRetentionDays + 10) * 24 * 60 * 60 * 1000,
	).toISOString()
	for (let index = 0; index < 5; index += 1) {
		await store.finishRun({
			run: createRunRow({
				id: `aged-${index}`,
				status: 'success',
				startedAt: agedStartedAt,
				finishedAt: agedStartedAt,
			}),
			logs: [],
		})
	}
	await finishRunRecord({
		env: retentionEnv,
		handle: beginRunRecord({
			env,
			userId,
			context: { surface: 'job', name: 'trigger', packageId: 'pkg-keep' },
		}),
		status: 'success',
	})
	expect(
		(await listRunRecords({ env, userId, limit: 100 })).runs.map(
			(run) => run.name,
		),
	).toEqual(['trigger'])

	// Excess-count prune also leaves dedicated state alone.
	for (let index = 0; index < runRecordMaxRunsPerUser + 10; index += 1) {
		await store.finishRun({
			run: createRunRow({
				id: `excess-${String(index).padStart(4, '0')}`,
				status: 'success',
				finishedAt: new Date().toISOString(),
			}),
			logs: [],
		})
	}
	await finishRunRecord({
		env: retentionEnv,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'excess-trigger',
				packageId: 'pkg-keep',
			},
		}),
		status: 'error',
	})
	expect(
		runRecords.dynamo
			.items(runRecords.tableName)
			.filter(
				(item) =>
					item.pk?.S === userId &&
					item.sk?.S?.startsWith('run#') &&
					Number(item.expiresAt?.N) > Date.now() / 1000,
			),
	).toHaveLength(runRecordMaxRunsPerUser)
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep' }),
	).toMatchObject({ jobId: 'job-keep', successCount: 1 })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-keep', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({ milestone: 'package_run_succeeded' }),
	])
})

test('export pages runs and dedicated state, then the DO ledger and projections; clearAll purges both', async () => {
	const userId = uniqueUserId('export')
	for (const name of ['export-run', 'export-run-2']) {
		await finishRunRecord({
			env,
			handle: beginRunRecord({
				env,
				userId,
				context: { surface: 'job', name, packageId: 'pkg-export' },
			}),
			status: 'success',
			logs: [`${name} done`],
		})
	}
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-export',
			status: 'success',
			ranAt: '2026-07-31T00:00:00.000Z',
			durationMs: 3,
		},
	})
	const ledgerRow: PackageInvocationLedgerRecord = {
		id: 'ledger-1',
		tokenId: 'token-export',
		packageId: 'pkg-export',
		packageKodyId: 'kody-export',
		exportName: 'handler',
		idempotencyKey: 'export-evt',
		requestHash: 'hash-export',
		source: null,
		topic: null,
		status: 'completed',
		responseJson: '{"ok":true}',
		createdAt: '2026-07-31T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z',
	}
	const exportEnv = {
		...env,
		RUN_STATE: legacyRunLog({
			packageInvocations: [ledgerRow],
			workflowProjections: [projection('wf-export', 'complete')],
		}),
	} as unknown as Env

	const seen = {
		runs: new Set<string>(),
		logs: [] as Array<string>,
		ledger: new Set<string>(),
		workflows: new Set<string>(),
		jobs: new Set<string>(),
		successes: new Set<string>(),
		milestones: new Set<string>(),
	}
	let startAfter: string | null = null
	for (let page = 0; page < 20; page += 1) {
		const exported = await exportRunRecords({
			env: exportEnv,
			userId,
			pageSize: 2,
			startAfter,
		})
		for (const run of exported.runs) seen.runs.add(run.id)
		seen.logs.push(...exported.logs.map((line) => line.message))
		for (const row of exported.packageInvocations) seen.ledger.add(row.id)
		for (const row of exported.workflowProjections) seen.workflows.add(row.id)
		for (const row of exported.jobRunObservability) seen.jobs.add(row.jobId)
		for (const row of exported.packageRunSuccesses) {
			seen.successes.add(row.packageId)
		}
		for (const row of exported.activationMilestones) {
			seen.milestones.add(row.milestone)
		}
		if (!exported.truncated) break
		startAfter = exported.nextStartAfter
	}
	expect(seen.runs.size).toBe(2)
	expect(seen.logs.sort()).toEqual(['export-run done', 'export-run-2 done'])
	expect([...seen.ledger]).toEqual(['ledger-1'])
	expect([...seen.workflows]).toEqual(['wf-export'])
	expect([...seen.jobs]).toEqual(['job-export'])
	expect([...seen.successes]).toEqual(['pkg-export'])
	expect([...seen.milestones].sort()).toEqual([
		'package_activated',
		'package_run_succeeded',
	])

	// A raw run-id cursor resumes the runs phase.
	const firstRunId = [...seen.runs].sort()[0]!
	const fromRunCursor = await exportRunRecords({
		env: exportEnv,
		userId,
		pageSize: 50,
		startAfter: firstRunId,
	})
	expect(fromRunCursor.runs.map((run) => run.id)).toEqual(
		[...seen.runs].sort().slice(1),
	)

	await clearRunRecords({ env: exportEnv, userId })
	expect(
		await exportRunRecords({ env: exportEnv, userId, pageSize: 50 }),
	).toMatchObject({
		runs: [],
		logs: [],
		packageInvocations: [],
		workflowProjections: [],
		jobRunObservability: [],
		packageRunSuccesses: [],
		activationMilestones: [],
		truncated: false,
		nextStartAfter: null,
	})
	// The store accepts new writes after clearAll.
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-after',
			status: 'error',
			ranAt: '2026-08-01T00:00:00.000Z',
		},
	})
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-after' }),
	).toMatchObject({ runCount: 1, errorCount: 1 })
})

test('export cursors always make progress across phase handoffs and empty tails', async () => {
	const userId = uniqueUserId('export-progress')
	// Exactly pageSize runs so the first page hands off with remaining=0.
	for (let index = 0; index < 2; index += 1) {
		await finishRunRecord({
			env,
			handle: beginRunRecord({
				env,
				userId,
				context: {
					surface: 'job',
					name: `run-${index}`,
					jobId: `job-progress-${index}`,
					packageId: 'pkg-progress',
				},
			}),
			status: 'success',
		})
	}
	const exportEnv = {
		...env,
		RUN_STATE: legacyRunLog({
			workflowProjections: [projection('wf-progress', 'complete')],
		}),
	} as unknown as Env

	const cursors: Array<string> = []
	let startAfter: string | null = null
	const seen = { workflows: 0, jobs: 0 }
	for (let page = 0; page < 12; page += 1) {
		const exported = await exportRunRecords({
			env: exportEnv,
			userId,
			pageSize: 2,
			startAfter,
		})
		seen.workflows += exported.workflowProjections.length
		seen.jobs += exported.jobRunObservability.length
		if (!exported.truncated) {
			expect(exported.nextStartAfter).toBeNull()
			break
		}
		// Truncated pages must advance the cursor; repeating one spins clients.
		expect(exported.nextStartAfter).not.toBeNull()
		expect(exported.nextStartAfter).not.toBe(startAfter)
		cursors.push(exported.nextStartAfter!)
		startAfter = exported.nextStartAfter
	}
	expect(seen).toEqual({ workflows: 1, jobs: 2 })
	expect(new Set(cursors).size).toBe(cursors.length)

	// Prefixed cursors past all remaining rows terminate (never re-emit).
	const emptyUser = uniqueUserId('export-empty-tail')
	for (const emptyTail of [
		'invocation-ledger:',
		'workflow-projections:',
		'job-run-observability:',
		'package-run-successes:',
		'activation-milestones:',
		'activation-milestones:zzz',
	]) {
		expect(
			await exportRunRecords({
				env: { ...env, RUN_STATE: legacyRunLog({}) } as unknown as Env,
				userId: emptyUser,
				pageSize: 2,
				startAfter: emptyTail,
			}),
		).toMatchObject({
			truncated: false,
			nextStartAfter: null,
			runs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
		})
	}
})

test('getAdminInsightsSnapshot returns content-free workflow, job, and activation aggregates', async () => {
	const userId = uniqueUserId('admin-insights')
	for (const [name, jobId] of [
		['activate', 'job-admin'],
		['activate-2', null],
	] as const) {
		await finishRunRecord({
			env,
			handle: beginRunRecord({
				env,
				userId,
				context: { surface: 'job', name, packageId: 'pkg-admin', jobId },
			}),
			status: 'success',
		})
	}
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'secret-job-must-not-leak',
			status: 'error',
			ranAt: '2026-08-01T12:00:00.000Z',
			error: 'secret-job-error-must-not-leak',
		},
	})
	const snapshot = await getAdminInsightsSnapshot({
		env: {
			...env,
			RUN_STATE: legacyRunLog({
				workflowProjections: [
					projection('wf-running-1', 'running'),
					projection('wf-running-2', 'running'),
					projection('wf-complete', 'complete'),
				],
			}),
		} as unknown as Env,
		userId,
	})
	expect(snapshot.workflowStatusCounts).toEqual([
		{ status: 'running', count: 2 },
		{ status: 'complete', count: 1 },
	])
	expect(snapshot.activationMilestones).toEqual([
		{
			milestone: 'package_activated',
			packageId: 'pkg-admin',
			reachedAt: expect.any(String),
		},
		{
			milestone: 'package_run_succeeded',
			packageId: 'pkg-admin',
			reachedAt: expect.any(String),
		},
	])
	expect(snapshot.jobRunCounts).toEqual({ success: 1, error: 1 })

	const serialized = JSON.stringify(snapshot)
	for (const secret of [
		/secret-name/,
		/secret-error-must-not-leak/,
		/secret-job-must-not-leak/,
		/secret-job-error-must-not-leak/,
		/job-admin/,
		/"name"/,
		/lastError|errorMessage|workflowName|"logs"/,
	]) {
		expect(serialized).not.toMatch(secret)
	}
	expect(Object.keys(snapshot).sort()).toEqual([
		'activationMilestones',
		'jobRunCounts',
		'workflowStatusCounts',
	])
})
