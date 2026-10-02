import { defineSearchAttributeKey } from '@temporalio/common'
import {
	continueAsNew,
	proxyActivities,
	workflowInfo,
} from '@temporalio/workflow'
import { type KodyActivities, type LaneOutcome } from '../activities/types.ts'

const scheduledStartTime = defineSearchAttributeKey(
	'TemporalScheduledStartTime',
	'DATETIME',
)

const { runScheduledLane } = proxyActivities<
	Pick<KodyActivities, 'runScheduledLane'>
>({
	startToCloseTimeout: '15 minutes',
	// Only lock contention throws (the write did not commit); the former
	// scheduled-dispatch queue retried it 3 times, 10 s × 3ⁿ capped at 90 s.
	// Other lane failures return `failed` and are never replayed.
	retry: {
		initialInterval: '10 seconds',
		backoffCoefficient: 3,
		maximumInterval: '90 seconds',
		maximumAttempts: 4,
	},
})

const { oauthPurgeStep } = proxyActivities<
	Pick<KodyActivities, 'oauthPurgeStep'>
>({ startToCloseTimeout: '1 minute' })

function firedAt() {
	return (
		workflowInfo().typedSearchAttributes.get(scheduledStartTime) ??
		new Date(workflowInfo().startTime)
	)
}

/** One fire of the Schedule `lane:{name}` (`ops` queue). */
export async function MaintenanceLane(input: {
	lane: string
	cron: string
}): Promise<LaneOutcome> {
	return runScheduledLane({
		lane: input.lane,
		scheduledAt: firedAt().toISOString(),
		cron: input.cron,
	})
}

export const oauthPurgeStepsPerRun = 200

/**
 * One full OAuth purge sweep (Schedule `lane:oauth_purge_expired`): grant
 * and token pages alternate until both phases finish a pass. The paging
 * continuation travels through Continue-As-New, replacing the
 * `OAuthPurgeCoordinator` Durable Object's storage; the Schedule's overlap
 * policy keeps sweeps serialized as the global DO did.
 */
export async function OAuthPurgeSweep(
	input: {
		continuation?: unknown
		stepsPerRun?: number
		grantsPurged?: number
		tokensPurged?: number
		grantsPassDone?: boolean
		tokensPassDone?: boolean
		steps?: number
		nowSeconds?: number
	} = {},
): Promise<{ steps: number; grantsPurged: number; tokensPurged: number }> {
	let continuation = input.continuation
	let grantsPurged = input.grantsPurged ?? 0
	let tokensPurged = input.tokensPurged ?? 0
	let grantsPassDone = input.grantsPassDone ?? false
	let tokensPassDone = input.tokensPassDone ?? false
	const previousSteps = input.steps ?? 0
	const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
	const budget = Math.max(
		1,
		Math.min(input.stepsPerRun ?? oauthPurgeStepsPerRun, oauthPurgeStepsPerRun),
	)
	for (let step = 1; step <= budget; step += 1) {
		const next = await oauthPurgeStep({
			continuation,
			nowSeconds,
		})
		continuation = next.continuation
		grantsPurged += next.result.grantsPurged
		tokensPurged += next.result.tokensPurged
		if (next.result.phase === 'grants') {
			grantsPassDone = next.result.phaseComplete
		} else {
			tokensPassDone = next.result.phaseComplete
		}
		if (grantsPassDone && tokensPassDone) {
			return { steps: previousSteps + step, grantsPurged, tokensPurged }
		}
	}
	return continueAsNew<typeof OAuthPurgeSweep>({
		continuation,
		stepsPerRun: input.stepsPerRun,
		grantsPurged,
		tokensPurged,
		grantsPassDone,
		tokensPassDone,
		steps: previousSteps + budget,
		nowSeconds,
	})
}
