import { expect, test } from 'vitest'
import {
	parseTemporalActivityRequest,
	parseTemporalGatewayReconciliationRequest,
	parseTemporalGatewaySignalWithStartRequest,
} from './schemas.ts'

const input = {
	workflowId: 'kody-stripe-plan-refresh-v1:opaque',
	userHash: 'opaque-user-hash',
	coordinatorRef: `coordinator:stripe-plan-refresh.${'a'.repeat(32)}`,
	refreshAt: '2026-09-23T14:00:00.000Z',
}

test('Stripe plan refresh Activity input accepts only the opaque coordinator contract', () => {
	expect(
		parseTemporalActivityRequest(
			'/__temporal/v1/coordinators/stripe-plan-refresh',
			{ ...input, temporalRunId: 'temporal-run-1' },
		),
	).toEqual({ ...input, temporalRunId: 'temporal-run-1' })
	expect(() =>
		parseTemporalActivityRequest(
			'/__temporal/v1/coordinators/stripe-plan-refresh',
			{ ...input, userId: 'raw-owner' },
		),
	).toThrow('Unexpected field userId')
})

test('signal-with-start requires matching workflow and due-time identities', () => {
	const request = {
		workflowType: 'stripePlanRefreshWorkflow',
		workflowId: input.workflowId,
		taskQueue: 'kody-foundation',
		input,
		signalName: 'rescheduleStripePlanRefresh',
		signalArgs: [input.refreshAt],
	}
	expect(parseTemporalGatewaySignalWithStartRequest(request)).toEqual(request)
	expect(() =>
		parseTemporalGatewaySignalWithStartRequest({
			...request,
			signalArgs: ['2026-09-23T15:00:00.000Z'],
		}),
	).toThrow('Signal-with-start identity mismatch')
})

test('reconciliation samples are bounded to the dynamic package workflow type', () => {
	expect(
		parseTemporalGatewayReconciliationRequest({
			workflowType: 'dynamicPackageWorkflow',
			limit: 250,
		}),
	).toEqual({ workflowType: 'dynamicPackageWorkflow', limit: 250 })
	expect(() =>
		parseTemporalGatewayReconciliationRequest({
			workflowType: 'jobOccurrenceWorkflow',
			limit: 250,
		}),
	).toThrow('Invalid workflowType')
	expect(() =>
		parseTemporalGatewayReconciliationRequest({
			workflowType: 'dynamicPackageWorkflow',
			limit: 501,
		}),
	).toThrow('Invalid limit')
})
