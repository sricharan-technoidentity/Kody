import { ApplicationFailure } from '@temporalio/common'
import {
	repoSessionMethods,
	type RepoSessionRpc,
} from '#worker/repo/repo-session-rpc.ts'
import { nextRepoSessionDueAt } from '#worker/repo/repo-session-due.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'

export type RepoSessionOperation = {
	userId: string
	sessionId: string
	method: keyof RepoSessionRpc
	payload: Record<string, unknown>
}
export type RepoSessionActivities = {
	operateRepoSession(
		input: RepoSessionOperation,
	): Promise<{ result: unknown; dueAt: number | null }>
	closeRepoSession(input: { userId: string; sessionId: string }): Promise<void>
}

export function createRepoSessionActivities(input: {
	service: (
		userId: string,
		sessionId: string,
	) => Promise<RepoSessionRpc> | RepoSessionRpc
	row: (userId: string, sessionId: string) => Promise<RepoSessionRow | null>
}): RepoSessionActivities {
	return {
		async operateRepoSession(operation) {
			if (!repoSessionMethods.has(operation.method))
				throw ApplicationFailure.nonRetryable('Unknown repo session operation.')
			if (
				operation.method !== 'getEstimatedBytes' &&
				(operation.payload.userId !== operation.userId ||
					operation.payload.sessionId !== operation.sessionId)
			)
				throw ApplicationFailure.nonRetryable(
					'Repo session owner or session mismatch.',
				)
			const service = await input.service(operation.userId, operation.sessionId)
			const fn = service[operation.method]
			if (typeof fn !== 'function')
				throw ApplicationFailure.nonRetryable('Unknown repo session operation.')
			const result = await (
				fn as (payload: Record<string, unknown>) => Promise<unknown>
			).call(service, operation.payload)
			const row = await input.row(operation.userId, operation.sessionId)
			const due = row ? nextRepoSessionDueAt(row) : null
			return { result, dueAt: due ? Date.parse(due) : null }
		},
		async closeRepoSession(operation) {
			const service = await input.service(operation.userId, operation.sessionId)
			const row = await input.row(operation.userId, operation.sessionId)
			if (!row) return
			await service.cleanupSessionBranch({
				...operation,
				reason: row.status === 'active' ? 'abandoned' : 'expired',
			})
		},
	}
}
