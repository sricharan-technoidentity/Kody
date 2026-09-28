export const temporalOpenStatuses = ['RUNNING', 'CONTINUED_AS_NEW'] as const

export const temporalTerminalStatuses = [
	'COMPLETED',
	'FAILED',
	'CANCELED',
	'TERMINATED',
	'TIMED_OUT',
] as const

export type KodyTemporalStatus =
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled'

export type KodyWorkflowRunStatus =
	| 'queued'
	| 'running'
	| 'complete'
	| 'errored'
	| 'terminated'
	| 'cancelled'

export function mapTemporalWorkflowStatus(
	status: string,
): KodyWorkflowRunStatus {
	switch (status.toUpperCase()) {
		case 'COMPLETED':
			return 'complete'
		case 'FAILED':
		case 'TIMED_OUT':
			return 'errored'
		case 'CANCELED':
		case 'CANCELLED':
			return 'cancelled'
		case 'TERMINATED':
			return 'terminated'
		case 'RUNNING':
		case 'CONTINUED_AS_NEW':
			return 'running'
		default:
			return 'queued'
	}
}

export function mapTemporalStatus(status: string): KodyTemporalStatus {
	switch (status.toUpperCase()) {
		case 'COMPLETED':
			return 'succeeded'
		case 'FAILED':
		case 'TERMINATED':
		case 'TIMED_OUT':
			return 'failed'
		case 'CANCELED':
		case 'CANCELLED':
			return 'cancelled'
		case 'RUNNING':
		case 'CONTINUED_AS_NEW':
			return 'running'
		default:
			return 'pending'
	}
}
