import { condition, defineUpdate, setHandler } from '@temporalio/workflow'

export type Approver = { role: 'human' | 'agent'; userId: string }

export type HumanApprovalInput = {
	userId: string
	requestId: string
	kind: 'publish-lock' | 'secret-host' | 'share' | 'webhook-apply'
}

export const approveUpdate = defineUpdate<{ approved: true }, [Approver]>(
	'approve',
)

export const humanApprovalTimeout = '7 days'

/**
 * Waits for the owner's click in the signed-in browser UI. The Update
 * validator rejects agents and other accounts before anything is recorded,
 * so an agent learns it cannot approve instead of waiting.
 */
export async function HumanApproval(
	input: HumanApprovalInput,
): Promise<{ approved: boolean; approvedBy: string | null }> {
	let approvedBy: string | null = null
	setHandler(
		approveUpdate,
		(approver) => {
			approvedBy = approver.userId
			return { approved: true }
		},
		{
			validator(approver) {
				if (approver.role !== 'human') {
					throw new Error(
						'Approval requires a human in the signed-in browser UI.',
					)
				}
				if (approver.userId !== input.userId) {
					throw new Error('Only the owner can approve this request.')
				}
			},
		},
	)
	const approved = await condition(
		() => approvedBy !== null,
		humanApprovalTimeout,
	)
	return { approved, approvedBy }
}
