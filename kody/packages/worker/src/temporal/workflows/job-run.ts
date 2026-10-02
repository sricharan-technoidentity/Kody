import { defineSearchAttributeKey } from '@temporalio/common'
import {
	isCancellation,
	proxyActivities,
	upsertSearchAttributes,
	workflowInfo,
} from '@temporalio/workflow'
import {
	type JobRunInput,
	type KodyActivities,
	type RunOutcome,
} from '../activities/types.ts'
import { kodySearchAttributes } from '../search-attributes.ts'

const scheduledStartTime = defineSearchAttributeKey(
	'TemporalScheduledStartTime',
	'DATETIME',
)

const { runJob } = proxyActivities<Pick<KodyActivities, 'runJob'>>({
	startToCloseTimeout: '10 minutes',
	// The job's own run record and meter make a retry a second run. Rearm
	// separately after infrastructure failures so recovery never repeats execution.
	retry: { maximumAttempts: 1 },
})

const { rearmJobSchedules } = proxyActivities<
	Pick<KodyActivities, 'rearmJobSchedules'>
>({ startToCloseTimeout: '1 minute' })

/**
 * One fire of the Schedule `job:{userId}:{jobId}` (or a run-now request).
 * The activity consumes `job_runs_per_day`, runs the job and records the
 * run; recording an error run starts `EventFanout` for
 * `run.error.recorded`.
 */
export async function JobRun(input: JobRunInput): Promise<RunOutcome> {
	const firedAt = workflowInfo().typedSearchAttributes.get(scheduledStartTime)
	let outcome: RunOutcome
	try {
		outcome = await runJob({
			...input,
			scheduledAt: input.scheduledAt ?? firedAt?.toISOString() ?? null,
		})
	} catch (error) {
		if (!isCancellation(error))
			await rearmJobSchedules({ userId: input.userId })
		throw error
	}
	upsertSearchAttributes([
		{
			key: kodySearchAttributes.status,
			value: outcome.ok ? 'completed' : 'failed',
		},
	])
	return outcome
}
