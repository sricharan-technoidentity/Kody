import {
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	proxyActivities,
	setHandler,
	workflowInfo,
} from '@temporalio/workflow'
import {
	type CatalogActivities,
	type McpConnectionInput,
} from '../activities/catalog-types.ts'

export const reconnectMcpServer = defineSignal('reconnect')
export const removeMcpServer = defineSignal('remove')
export const mcpConnectionStatus = defineQuery<{
	connected: boolean
	failures: number
}>('status')

const { maintainMcpConnection, disconnectMcpConnection } = proxyActivities<
	Pick<CatalogActivities, 'maintainMcpConnection' | 'disconnectMcpConnection'>
>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 1 } })

/** Entity state is only reconnect/backoff state; credentials stay in the activity. */
export async function McpServerConnection(
	input: McpConnectionInput & {
		failures?: number
		stepsPerRun?: number
	},
): Promise<void> {
	let reconnect = false
	let removed = false
	let connected = false
	let failures = input.failures ?? 0
	setHandler(reconnectMcpServer, () => {
		reconnect = true
	})
	setHandler(removeMcpServer, () => {
		removed = true
	})
	setHandler(mcpConnectionStatus, () => ({ connected, failures }))
	const budget = Math.max(1, Math.min(input.stepsPerRun ?? 100, 100))
	for (let step = 0; step < budget; step += 1) {
		try {
			connected = (await maintainMcpConnection(input)).connected
		} catch {
			connected = false
		}
		failures = connected ? 0 : failures + 1
		const delay = connected
			? 300_000
			: Math.min(1_000 * 2 ** Math.min(failures, 8), 300_000)
		await condition(() => reconnect || removed, delay)
		if (removed) {
			await disconnectMcpConnection(input)
			return
		}
		reconnect = false
		if (workflowInfo().continueAsNewSuggested) break
	}
	return continueAsNew<typeof McpServerConnection>({ ...input, failures })
}
