/**
 * Workflow ids, task queues and Schedule ids exactly as in the target
 * architecture's workflow catalog. Every id starts with the owner's stable
 * user id except webhook deliveries (endpoint ids are already per-user),
 * event fan-out and maintenance lanes. Workflow-safe: no Node imports.
 */

export const taskQueues = {
	app: 'app',
	platform: 'platform',
	runtime: 'runtime',
	ops: 'ops',
} as const

export type TaskQueue = (typeof taskQueues)[keyof typeof taskQueues]

function part(label: string, value: string) {
	const trimmed = value.trim()
	if (!trimmed) throw new Error(`Workflow id ${label} must not be empty.`)
	return trimmed
}

export const workflowIds = {
	executeRun: (userId: string, requestId: string) =>
		`${part('userId', userId)}:execute:${part('requestId', requestId)}`,
	packageInvocation: (userId: string, surface: string, key: string) =>
		`${part('userId', userId)}:${part('surface', surface)}:${part('key', key)}`,
	jobSchedule: (userId: string, jobId: string) =>
		`job:${part('userId', userId)}:${part('jobId', jobId)}`,
	packageWorkflowRun: (userId: string, idempotencyKey: string) =>
		`${part('userId', userId)}:wf:${part('idempotencyKey', idempotencyKey)}`,
	webhookDelivery: (endpointId: string, deliveryId: string) =>
		`${part('endpointId', endpointId)}:${part('deliveryId', deliveryId)}`,
	eventFanout: (topic: string, eventId: string) =>
		`${part('topic', topic)}:${part('eventId', eventId)}`,
	publishPackage: (userId: string, packageId: string) =>
		`${part('userId', userId)}:publish:${part('packageId', packageId)}`,
	repoSession: (userId: string, sessionId: string) =>
		`${part('userId', userId)}:repo:${part('sessionId', sessionId)}`,
	mcpServerConnection: (userId: string, serverId: string) =>
		`${part('userId', userId)}:mcp:${part('serverId', serverId)}`,
	mail: (userId: string, messageId: string) =>
		`${part('userId', userId)}:mail:${part('messageId', messageId)}`,
	humanApproval: (userId: string, requestId: string) =>
		`${part('userId', userId)}:approve:${part('requestId', requestId)}`,
	accountDelete: (userId: string) => `${part('userId', userId)}:delete`,
	stripePlanRefresh: (userId: string) =>
		`${part('userId', userId)}:stripe-plan-refresh`,
	laneSchedule: (name: string) => `lane:${part('lane', name)}`,
	lane: (name: string, fireTime: string) =>
		`lane:${part('lane', name)}:${part('fireTime', fireTime)}`,
	/** Queue-message replacement: one Start per message, keyed by its dedupe key. */
	queueMessage: (queue: string, key: string) =>
		`queue:${part('queue', queue)}:${part('key', key)}`,
} as const
