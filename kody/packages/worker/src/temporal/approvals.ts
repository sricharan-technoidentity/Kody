import {
	type Client,
	WorkflowNotFoundError,
	WorkflowUpdateFailedError,
} from '@temporalio/client'
import { workflowIds } from './ids.ts'
import { approveUpdate, type Approver } from './workflows/human-approval.ts'

/**
 * The signed-in browser UI's approval click: an Update on
 * `{userId}:approve:{requestId}`. The workflow's validator refuses agents
 * and other accounts; their message is rethrown as is.
 */
export async function approveRequest(
	client: Client,
	input: { userId: string; requestId: string; approver: Approver },
) {
	const handle = client.workflow.getHandle(
		workflowIds.humanApproval(input.userId, input.requestId),
	)
	// The request is pending once its workflow runs (e.g. after publish
	// checks); an earlier, finished request with the same id is not it.
	const deadline = Date.now() + 15_000
	for (;;) {
		try {
			const { status } = await handle.describe()
			if (status.name === 'RUNNING') break
		} catch (error) {
			if (!(error instanceof WorkflowNotFoundError)) throw error
		}
		if (Date.now() > deadline) {
			throw new Error('No pending approval request with this id.')
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	try {
		return await handle.executeUpdate(approveUpdate, {
			args: [input.approver],
		})
	} catch (error) {
		if (error instanceof WorkflowUpdateFailedError && error.cause) {
			throw new Error(error.cause.message)
		}
		throw error
	}
}
