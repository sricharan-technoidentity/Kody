import {
	type CatalogActivities,
	type AccountDeleteInput,
	type InboundEmailInput,
	type MailObjectInput,
	type McpConnectionInput,
} from './activities/catalog-types.ts'
import { type KodyTemporal } from './client.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { startKodyWorkflow } from './start.ts'
import { kodySearchAttributes } from './search-attributes.ts'

export async function startAccountDelete(
	temporal: KodyTemporal,
	input: AccountDeleteInput,
) {
	return startKodyWorkflow(temporal, {
		workflowType: 'AccountDelete',
		workflowId: workflowIds.accountDelete(input.userId),
		taskQueue: taskQueues.app,
		args: [input],
		userId: input.userId,
		surface: 'account-delete',
	})
}

export async function startInboundEmail(
	temporal: KodyTemporal,
	input: InboundEmailInput,
) {
	return startKodyWorkflow(temporal, {
		workflowType: 'InboundEmail',
		workflowId: workflowIds.mail(input.userId, input.messageId),
		taskQueue: taskQueues.platform,
		args: [input],
		userId: input.userId,
		surface: 'inbound-email',
	})
}

export async function startOutboundEmail(
	temporal: KodyTemporal,
	input: MailObjectInput,
) {
	return startKodyWorkflow(temporal, {
		workflowType: 'OutboundEmail',
		workflowId: workflowIds.mail(input.userId, input.messageId),
		taskQueue: taskQueues.platform,
		args: [input],
		userId: input.userId,
		surface: 'outbound-email',
	})
}

export async function startMcpServerConnection(
	temporal: KodyTemporal,
	input: McpConnectionInput,
) {
	const client = await temporal.client(taskQueues.platform)
	return client.workflow.signalWithStart('McpServerConnection', {
		workflowId: workflowIds.mcpServerConnection(input.userId, input.serverId),
		taskQueue: taskQueues.platform,
		args: [input],
		signal: 'reconnect',
		signalArgs: [],
		typedSearchAttributes: [
			{ key: kodySearchAttributes.userId, value: input.userId },
			{ key: kodySearchAttributes.surface, value: 'mcp-connection' },
		],
	})
}

/** Authenticated callers choose their own owner id before resolving a handle. */
export async function signalMcpServerConnection(
	temporal: KodyTemporal,
	input: {
		userId: string
		serverId: string
		command: 'reconnect' | 'remove'
	},
) {
	const client = await temporal.client(taskQueues.platform)
	await client.workflow
		.getHandle(workflowIds.mcpServerConnection(input.userId, input.serverId))
		.signal(input.command)
}

export type { CatalogActivities }
