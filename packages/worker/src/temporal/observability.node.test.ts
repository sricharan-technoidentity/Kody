import { expect, test, vi } from 'vitest'
import { buildTemporalUserHash } from '@kody-internal/shared/temporal/identifiers.ts'
import { type WorkflowProjectionRecord } from '#worker/run-records/workflow-projection.ts'

const mocks = vi.hoisted(() => ({
	getWorkflowProjection: vi.fn(),
	loadTemporalWorkflowOwner: vi.fn(),
	sampleTemporalDynamicPackageWorkflows: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getWorkflowProjection: mocks.getWorkflowProjection,
}))

vi.mock('./client.ts', () => ({
	sampleTemporalDynamicPackageWorkflows:
		mocks.sampleTemporalDynamicPackageWorkflows,
}))

vi.mock('#worker/package-runtime/temporal-workflow-artifacts.ts', () => ({
	loadTemporalWorkflowOwner: mocks.loadTemporalWorkflowOwner,
}))

const {
	classifyTemporalWorkflowMismatch,
	reconcileTemporalWorkflowProjections,
	recordTemporalWorkflowConcurrency,
} = await import('./observability.ts')

function projection(
	status: string,
	overrides: Partial<WorkflowProjectionRecord> = {},
): WorkflowProjectionRecord {
	return {
		id: 'run-1',
		bindingName: 'TEMPORAL_DYNAMIC_PACKAGE_WORKFLOWS',
		sourceType: 'inline',
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'opaque-workflow',
		exportName: null,
		idempotencyKey: 'opaque-key',
		runAt: '2026-09-23T13:00:00.000Z',
		planDate: null,
		status,
		createdAt: '2026-09-23T13:00:00.000Z',
		updatedAt: '2026-09-23T13:05:00.000Z',
		completedAt: '2026-09-23T13:05:00.000Z',
		lastError: null,
		...overrides,
	}
}

test('mismatch classifier applies the reconciliation grace window', () => {
	const now = new Date('2026-09-23T14:00:00.000Z')
	expect(
		classifyTemporalWorkflowMismatch({
			temporalStatus: 'COMPLETED',
			temporalStartedAt: '2026-09-23T13:00:00.000Z',
			temporalClosedAt: '2026-09-23T13:30:00.000Z',
			projection: null,
			userHash: 'opaque-user-hash',
			now,
		}),
	).toMatchObject({
		kind: 'temporal_success_runlog_missing',
		ageBucket: '10m_to_1h',
		alertable: true,
	})
	expect(
		classifyTemporalWorkflowMismatch({
			temporalStatus: 'RUNNING',
			temporalStartedAt: '2026-09-23T13:00:00.000Z',
			projection: projection('complete'),
			userHash: 'opaque-user-hash',
			now,
		}),
	).toMatchObject({
		kind: 'runlog_terminal_temporal_open',
		ageBucket: '10m_to_1h',
		alertable: true,
	})
})

test('hourly reconciliation emits content-free mismatch and summary events', async () => {
	const userId = 'stable-user-1'
	const userHash = await buildTemporalUserHash(userId)
	mocks.sampleTemporalDynamicPackageWorkflows.mockResolvedValue({
		executions: [
			{
				workflowId: 'kody-package-v1:opaque',
				workflowType: 'dynamicPackageWorkflow',
				status: 'COMPLETED',
				startedAt: '2026-09-23T13:00:00.000Z',
				closedAt: '2026-09-23T13:30:00.000Z',
				userHash,
				workflowRunId: 'run-1',
				callerContextRef: 'artifact:workflow-caller.opaque',
			},
		],
		truncated: false,
	})
	mocks.getWorkflowProjection.mockResolvedValue(projection('running'))
	mocks.loadTemporalWorkflowOwner.mockResolvedValue(userId)
	const mismatches: Array<unknown> = []
	const summaries: Array<unknown> = []
	const summary = await reconcileTemporalWorkflowProjections({
		env: {
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			RUN_LOG: {} as DurableObjectNamespace,
			TEMPORAL_GATEWAY_URL: 'https://temporal.example',
			TEMPORAL_GATEWAY_SIGNING_KEYS: 'configured',
		},
		now: new Date('2026-09-23T14:00:00.000Z'),
		recordMismatch: (event) => mismatches.push(event),
		recordSummary: (event) => summaries.push(event),
	})

	expect(summary).toMatchObject({
		status: 'ok',
		temporalSuccessRunLogMissing: 1,
		alertableMismatches: 1,
	})
	expect(mismatches).toEqual([
		expect.objectContaining({ userHash, runLogStatus: 'running' }),
	])
	expect(JSON.stringify({ mismatches, summaries })).not.toContain(userId)
})

test('concurrency events hash the user and expose throttle outcome', async () => {
	const events: Array<unknown> = []
	const event = await recordTemporalWorkflowConcurrency({
		userId: 'stable-user-2',
		backend: 'temporal',
		current: 5,
		outcome: 'throttled',
		limit: 5,
		record: (value) => events.push(value),
	})

	expect(event).toMatchObject({
		backend: 'temporal',
		current: 5,
		outcome: 'throttled',
		limit: 5,
	})
	expect(JSON.stringify(events)).not.toContain('stable-user-2')
})
