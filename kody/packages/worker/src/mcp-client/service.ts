import { WorkflowNotFoundError } from '@temporalio/client'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { type KodyTemporal } from '#worker/temporal/client.ts'
import { taskQueues, workflowIds } from '#worker/temporal/ids.ts'
import { McpClientHub } from './hub.ts'
import { createMcpClientStorage, type McpCredentialVault } from './storage.ts'

export function createMcpClients(input: {
	forUser(userId: string): PgDatabase | Promise<PgDatabase>
	vault: McpCredentialVault
	temporal?: KodyTemporal
}) {
	const locks = new Map<string, Promise<unknown>>()
	async function run<T>(
		userId: string,
		operation: (hub: McpClientHub) => Promise<T>,
	): Promise<T> {
		if (!userId.trim()) throw new Error('MCP owner is required.')
		// ponytail: one owner lock per process; Aurora version checks reject concurrent catalog writes from other processes. Add a distributed entity Update for multi-instance mutation throughput.
		const previous = locks.get(userId) ?? Promise.resolve()
		const work = previous
			.catch(() => {})
			.then(async () => {
				const storage = await createMcpClientStorage({
					db: await input.forUser(userId),
					userId,
					vault: input.vault,
				})
				const hub = new McpClientHub(storage)
				try {
					return await operation(hub)
				} finally {
					try {
						await storage.flush()
					} finally {
						try {
							await hub.close()
						} finally {
							storage.close()
						}
					}
				}
			})
		locks.set(userId, work)
		try {
			return await work
		} finally {
			if (locks.get(userId) === work) locks.delete(userId)
		}
	}
	async function maintain(
		userId: string,
		serverId: string,
		callbackUrl: string,
	) {
		if (!input.temporal) return
		const client = await input.temporal.client(taskQueues.app)
		await client.workflow.signalWithStart('McpServerConnection', {
			workflowId: workflowIds.mcpServerConnection(userId, serverId),
			taskQueue: taskQueues.app,
			args: [{ userId, serverId, callbackUrl }],
			signal: 'reconnect',
			signalArgs: [],
		})
	}
	return {
		forUser(userId: string) {
			return {
				async addServer(args: Parameters<McpClientHub['addServer']>[0]) {
					const result = await run(userId, (hub) => hub.addServer(args))
					await maintain(userId, args.serverId, args.callbackUrl)
					return result
				},
				async reconnectServer(
					args: Parameters<McpClientHub['reconnectServer']>[0],
				) {
					return await run(userId, (hub) => hub.reconnectServer(args))
				},
				refreshServer: (args: Parameters<McpClientHub['refreshServer']>[0]) =>
					run(userId, (hub) => hub.refreshServer(args)),
				async removeServer(args: Parameters<McpClientHub['removeServer']>[0]) {
					if (input.temporal) {
						try {
							await (
								await input.temporal.client(taskQueues.app)
							).workflow
								.getHandle(
									workflowIds.mcpServerConnection(userId, args.serverId),
								)
								.signal('remove')
						} catch (error) {
							if (!(error instanceof WorkflowNotFoundError)) throw error
						}
					}
					await run(userId, (hub) => hub.removeServer(args))
				},
				handleOAuthCallback: (
					args: Parameters<McpClientHub['handleOAuthCallback']>[0],
				) => run(userId, (hub) => hub.handleOAuthCallback(args)),
				getSnapshot: () => run(userId, (hub) => hub.getSnapshot()),
				peekServers: () => run(userId, (hub) => hub.peekServers()),
				callTool: (args: Parameters<McpClientHub['callTool']>[0]) =>
					run(userId, (hub) => hub.callTool(args)),
				peekConnectionEvents: () =>
					run(userId, (hub) => hub.peekConnectionEvents()),
				ackConnectionEvents: (ids: string[]) =>
					run(userId, (hub) => hub.ackConnectionEvents(ids)),
				purgeForAccountDeletion: () =>
					run(userId, (hub) => hub.purgeForAccountDeletion()),
			}
		},
	}
}
export type McpClients = ReturnType<typeof createMcpClients>
