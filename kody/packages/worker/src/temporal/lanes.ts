import {
	type Client,
	ScheduleAlreadyRunning,
	type ScheduleOptionsAction,
} from '@temporalio/client'
import { type ScheduledLaneName } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { deleteSchedule } from './schedules.ts'

const everyFiveMinutes = '*/5 * * * *'
const hourly = '0 * * * *'

/**
 * One Temporal Schedule per maintenance lane, in UTC, reproducing the old
 * five-minute cron's cadence predicates (`getScheduledLaneCadence`).
 * D1 exports/storage and DO billing lanes are retired in the target. Not
 * scheduled: the two inactive no-op lanes and `job_schedule_watchdog`
 * (job Schedules replace JobManager alarms).
 */
export const laneSchedules = [
	{ lane: 'reconcile_artifacts_pushes', cron: everyFiveMinutes },
	{ lane: 'repo_session_cleanup', cron: everyFiveMinutes },
	{ lane: 'reconcile_inbound_deliveries', cron: everyFiveMinutes },
	{ lane: 'system_email_retention', cron: everyFiveMinutes },
	{ lane: 'storage_bucket_estimate_backfill', cron: everyFiveMinutes },
	{ lane: 'oauth_purge_expired', cron: everyFiveMinutes },
	{ lane: 'retention', cron: hourly },
	{ lane: 'job_retention', cron: hourly },
	{ lane: 'run_records_reconciliation', cron: hourly },
	{ lane: 'unverified_account_purge', cron: hourly },
	{ lane: 'usage_aggregation', cron: hourly },
	{ lane: 'auth_denial_alert', cron: hourly },
	{ lane: 'email_delivery_alert', cron: hourly },
	{ lane: 'email_verification_stall_alert', cron: hourly },
	{ lane: 'usage_entitlement_alert', cron: hourly },
	{ lane: 'kit_subscriber_sync', cron: hourly },
] as const satisfies ReadonlyArray<{ lane: ScheduledLaneName; cron: string }>

function laneAction(lane: ScheduledLaneName, cron: string) {
	const base = {
		type: 'startWorkflow' as const,
		workflowId: workflowIds.laneSchedule(lane),
		taskQueue: taskQueues.ops,
	}
	return (
		lane === 'oauth_purge_expired'
			? { ...base, workflowType: 'OAuthPurgeSweep', args: [{}] }
			: { ...base, workflowType: 'MaintenanceLane', args: [{ lane, cron }] }
	) satisfies ScheduleOptionsAction
}

/**
 * Create or update every lane Schedule (`lane:{name}`). Runs at ops-worker
 * start; a lane still running when its next fire comes is skipped, and
 * missed fires are not replayed (the old cron dropped them too).
 */
export async function upsertLaneSchedules(client: Client) {
	for (const lane of [
		'dr_export',
		'dr_export_watchdog',
		'd1_storage_reconciliation',
		'durable_object_duration_attribution',
	]) {
		await deleteSchedule(client, workflowIds.laneSchedule(lane))
	}
	for (const { lane, cron } of laneSchedules) {
		const options = {
			spec: { cronExpressions: [cron], timezone: 'UTC' },
			action: laneAction(lane, cron),
			policies: { overlap: 'SKIP' as const, catchupWindow: '1 minute' },
		}
		const scheduleId = workflowIds.laneSchedule(lane)
		try {
			await client.schedule.create({ scheduleId, ...options })
		} catch (error) {
			if (!(error instanceof ScheduleAlreadyRunning)) throw error
			await client.schedule.getHandle(scheduleId).update((previous) => ({
				...previous,
				...options,
			}))
		}
	}
}
