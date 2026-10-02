import { expect, test } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { laneSchedules, upsertLaneSchedules } from './lanes.ts'

test('ops schedules exclude retired CF exports and billing, update in place, and dispatch the OAuth paging workflow', async () => {
	const temporal = await createTemporalEnv()
	try {
		await temporal.client.schedule.create({
			scheduleId: 'lane:dr_export',
			spec: { cronExpressions: ['*/5 * * * *'] },
			action: {
				type: 'startWorkflow',
				workflowType: 'MaintenanceLane',
				workflowId: 'lane:dr_export',
				taskQueue: 'ops',
				args: [{ lane: 'dr_export' }],
			},
		})
		await upsertLaneSchedules(temporal.client)
		await upsertLaneSchedules(temporal.client)
		for (const retired of [
			'dr_export',
			'dr_export_watchdog',
			'd1_storage_reconciliation',
			'durable_object_duration_attribution',
		])
			expect(laneSchedules.map((item) => item.lane)).not.toContain(retired)
		await expect(
			temporal.client.schedule.getHandle('lane:dr_export').describe(),
		).rejects.toThrow('not found')
		const oauth = await temporal.client.schedule
			.getHandle('lane:oauth_purge_expired')
			.describe()
		expect(oauth.action).toMatchObject({
			workflowType: 'OAuthPurgeSweep',
			taskQueue: 'ops',
			args: [{}],
		})
		expect(oauth.policies.overlap).toBe('SKIP')
		const retention = await temporal.client.schedule
			.getHandle('lane:retention')
			.describe()
		expect(retention.action).toMatchObject({
			workflowType: 'MaintenanceLane',
			args: [{ lane: 'retention', cron: '0 * * * *' }],
		})
	} finally {
		await temporal.close()
	}
})

test('OAuth sweep preserves completed phases, cutoff and totals across Continue-As-New', async () => {
	const temporal = await createTemporalEnv()
	try {
		const cutoffs: number[] = []
		const laneCalls: unknown[] = []
		await temporal.startWorkers({
			queues: ['ops'],
			activities: {
				async runScheduledLane(input) {
					laneCalls.push(input)
					return 'failed'
				},
				async oauthPurgeStep(input) {
					cutoffs.push(input.nowSeconds)
					const phase = input.continuation ? 'tokens' : 'grants'
					return {
						continuation: { phase: 'tokens' },
						result: {
							phase,
							checked: 1,
							grantsPurged: phase === 'grants' ? 2 : 0,
							tokensPurged: phase === 'tokens' ? 3 : 0,
							phaseComplete: true,
						},
					}
				},
			},
		})
		const handle = await temporal.client.workflow.start('OAuthPurgeSweep', {
			workflowId: 'lane:oauth-test',
			taskQueue: 'ops',
			args: [{ stepsPerRun: 1 }],
		})
		expect(await handle.result()).toEqual({
			steps: 2,
			grantsPurged: 2,
			tokensPurged: 3,
		})
		expect(cutoffs).toHaveLength(2)
		expect(cutoffs[0]).toBe(cutoffs[1])
		expect(
			await temporal.client.workflow.execute('MaintenanceLane', {
				workflowId: 'lane:retention-test',
				taskQueue: 'ops',
				args: [{ lane: 'retention', cron: '0 * * * *' }],
			}),
		).toBe('failed')
		expect(laneCalls).toEqual([
			{
				lane: 'retention',
				cron: '0 * * * *',
				scheduledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			},
		])
	} finally {
		await temporal.close()
	}
})
