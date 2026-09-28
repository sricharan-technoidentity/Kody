import { type McpCallerContext } from '../chat.ts'
import { type JobRow } from './repo.ts'
import {
	type ScheduledLaneMessage,
	type ScheduledLaneOutcome,
} from './scheduled-lanes.ts'
import { type SchedulerJobOutcomeLog } from './scheduler-logging.ts'
import { type JobsStore } from './store.ts'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobView,
} from './types.ts'

/**
 * Service-binding contract the jobs worker exposes to the main worker
 * (`JOBS` binding → `JobsService` entrypoint, ADR 0016). It is the jobs
 * store plus Temporal occurrence coordination.
 */
export type JobsServiceContract = JobsStore & {
	claimTemporalJobOccurrence(input: {
		userHash: string
		jobId: string
		scheduledFor: string
		claimRef: string
	}): Promise<{
		claimed: boolean
		claimRef?: string
		reason?: 'already-completed' | 'not-runnable' | 'claim-held'
	}>
	getTemporalClaimedJob(input: {
		userHash: string
		jobId: string
		claimRef: string
	}): Promise<JobRow | null>
	finalizeTemporalJobOccurrence(input: {
		userHash: string
		jobId: string
		claimRef: string
		scheduledFor: string
		status: 'succeeded' | 'failed' | 'cancelled'
		finishedAt: string
	}): Promise<boolean>
	purgeUser(input: {
		userId: string
	}): Promise<{ ok: true; userId: string; purged: boolean }>
	runJobNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<RunJobNowResult>
}

export type RunDueJobsResult = {
	dueJobCount: number
	successCount: number
	errorCount: number
	jobOutcomes: Array<SchedulerJobOutcomeLog>
}

export type RunJobNowResult = {
	job: JobView
	execution: JobExecutionResult
	deletedAfterRun: boolean
}

/**
 * Service-binding contract the main worker exposes to the jobs worker
 * (`HOST` binding → `JobsHost` entrypoint, ADR 0016). Job execution and the
 * platform scheduled lanes stay in the main worker — they are welded to the
 * package runtime, run records, entitlements, and email subsystems — so the
 * jobs worker calls back through this deliberately small surface.
 */
export type JobsHostContract = {
	/** Execute a single job immediately. */
	runJobNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<RunJobNowResult>
	/** Execute one platform scheduled lane with failure isolation. */
	runScheduledLane(message: ScheduledLaneMessage): Promise<ScheduledLaneOutcome>
}
