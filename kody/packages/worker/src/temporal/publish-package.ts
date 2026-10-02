import { type AwsEnv } from '../aws/env.ts'
import { approveRequest } from './approvals.ts'
import { taskQueues, workflowIds } from './ids.ts'
import { kodySearchAttributes } from './search-attributes.ts'
import {
	publishApprovalRequestId,
	type PublishPackage,
} from './workflows/publish-package.ts'

/**
 * Start (or attach to) `{userId}:publish:{packageId}`; for a locked package
 * the approver's click goes to the publish's `HumanApproval`.
 */
export async function publishPackage(input: {
	env: AwsEnv
	userId: string
	packageId: string
	commit: string
	locked: boolean
	approvedBy?: { role: 'human' | 'agent'; userId: string }
}): Promise<{ publishedCommit: string; bundleKey: string }> {
	const client = await input.env.TEMPORAL.client(taskQueues.platform)
	const handle = await client.workflow.start<typeof PublishPackage>(
		'PublishPackage',
		{
			workflowId: workflowIds.publishPackage(input.userId, input.packageId),
			taskQueue: taskQueues.platform,
			args: [
				{
					userId: input.userId,
					packageId: input.packageId,
					commit: input.commit,
					locked: input.locked,
				},
			],
			workflowIdConflictPolicy: 'USE_EXISTING',
			typedSearchAttributes: [
				{ key: kodySearchAttributes.userId, value: input.userId },
				{ key: kodySearchAttributes.surface, value: 'publish' },
				{ key: kodySearchAttributes.packageId, value: input.packageId },
			],
		},
	)
	if (input.locked && input.approvedBy) {
		await approveRequest(client, {
			userId: input.userId,
			requestId: publishApprovalRequestId(input.packageId, input.commit),
			approver: input.approvedBy,
		})
	}
	return handle.result()
}
