import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import { type KodyTemporal } from '#worker/temporal/client.ts'
import { taskQueues } from '#worker/temporal/ids.ts'
import { repoSessionMethods, type RepoSessionRpc } from './repo-session-rpc.ts'

/** Every session workflow belongs to the authenticated owner, never just a caller-supplied ID. */
export function createRepoSessionClient(
	temporal: KodyTemporal,
	userId: string,
	sessionId: string,
): RepoSessionRpc {
	if (!userId || !sessionId)
		throw new Error('Repo session owner and session are required.')
	const workflowId = `${userId}:repo:${sessionId}`
	return new Proxy({} as RepoSessionRpc, {
		get(_target, method: keyof RepoSessionRpc) {
			if (!repoSessionMethods.has(method)) return undefined
			return async (payload: Record<string, unknown> = {}) => {
				if (
					method !== 'getEstimatedBytes' &&
					(payload.userId !== userId ||
						(payload.sessionId !== undefined &&
							payload.sessionId !== sessionId))
				)
					throw new Error('Repo session owner or session mismatch.')
				const client = await temporal.client(taskQueues.platform)
				try {
					await client.workflow.start('RepoSession', {
						workflowId,
						taskQueue: taskQueues.platform,
						args: [{ userId, sessionId }],
					})
				} catch (error) {
					if (!(error instanceof WorkflowExecutionAlreadyStartedError))
						throw error
				}
				const update =
					method === 'sessionCommit'
						? 'commit'
						: method === 'applyEdits' ||
							  method === 'applyPatch' ||
							  method === 'writeFile'
							? 'edit'
							: 'operation'
				return client.workflow.getHandle(workflowId).executeUpdate(update, {
					args: [
						{ userId, sessionId, method, payload: { ...payload, sessionId } },
					],
				})
			}
		},
	})
}
