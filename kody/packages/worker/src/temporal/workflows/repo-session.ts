import { ApplicationFailure } from '@temporalio/common'
import {
	allHandlersFinished,
	condition,
	continueAsNew,
	defineQuery,
	defineUpdate,
	proxyActivities,
	setHandler,
	workflowInfo,
} from '@temporalio/workflow'
import {
	type RepoSessionActivities,
	type RepoSessionOperation,
} from '../activities/repo-session.ts'

export const repoSessionOperation = defineUpdate<
	unknown,
	[RepoSessionOperation]
>('operation')
export const repoSessionEdit = defineUpdate<unknown, [RepoSessionOperation]>(
	'edit',
)
export const repoSessionCommit = defineUpdate<unknown, [RepoSessionOperation]>(
	'commit',
)
export const repoSessionState = defineQuery<{
	operations: number
	dueAt: number
}>('state')
const { operateRepoSession, closeRepoSession } =
	proxyActivities<RepoSessionActivities>({
		startToCloseTimeout: '15 minutes',
		retry: { maximumAttempts: 1 },
	})

/** All edits/commits serialize as Updates; git credentials and file contents stay in activities. */
export async function RepoSession(input: {
	userId: string
	sessionId: string
	dueAt?: number
	stepsPerRun?: number
}): Promise<void> {
	let dueAt = input.dueAt ?? Date.now() + 30 * 60_000
	let operations = 0
	let closing = false
	let serial: Promise<unknown> = Promise.resolve()
	function validate(operation: RepoSessionOperation) {
		if (closing)
			throw ApplicationFailure.nonRetryable('Repo session is closing.')
		if (
			operation.userId !== input.userId ||
			operation.sessionId !== input.sessionId
		)
			throw ApplicationFailure.nonRetryable(
				'Repo session owner or session mismatch.',
			)
	}
	async function handle(operation: RepoSessionOperation) {
		const pending = serial.then(async () => {
			const output = await operateRepoSession(operation)
			dueAt = output.dueAt ?? Date.now() + 30 * 60_000
			operations += 1
			return output.result
		})
		serial = pending.catch(() => undefined)
		return pending
	}
	setHandler(repoSessionOperation, handle, { validator: validate })
	setHandler(repoSessionEdit, handle, {
		validator(operation) {
			validate(operation)
			if (
				operation.method !== 'applyEdits' &&
				operation.method !== 'applyPatch' &&
				operation.method !== 'writeFile'
			)
				throw new Error('Expected an edit operation.')
		},
	})
	setHandler(repoSessionCommit, handle, {
		validator(operation) {
			validate(operation)
			if (operation.method !== 'sessionCommit')
				throw new Error('Expected a commit operation.')
		},
	})
	setHandler(repoSessionState, () => ({ operations, dueAt }))
	const budget = Math.max(1, Math.min(input.stepsPerRun ?? 100, 100))
	while (Date.now() < dueAt) {
		const waitingUntil = dueAt
		await condition(
			() =>
				dueAt !== waitingUntil ||
				operations >= budget ||
				workflowInfo().continueAsNewSuggested,
			Math.max(1, dueAt - Date.now()),
		)
		await condition(allHandlersFinished)
		if (operations >= budget || workflowInfo().continueAsNewSuggested)
			return continueAsNew<typeof RepoSession>({ ...input, dueAt })
	}
	closing = true
	await closeRepoSession(input)
}
