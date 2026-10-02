import { ApplicationFailure } from '@temporalio/common'
import { executeChild, proxyActivities } from '@temporalio/workflow'
import { type KodyActivities, type PublishCheck } from '../activities/types.ts'
import { taskQueues, workflowIds } from '../ids.ts'
import { HumanApproval } from './human-approval.ts'

export type PublishPackageInput = {
	userId: string
	packageId: string
	commit: string
	locked: boolean
}

export const publishChecks: ReadonlyArray<PublishCheck> = [
	'bundle',
	'typecheck',
	'lint',
]

export function publishApprovalRequestId(packageId: string, commit: string) {
	return `publish:${packageId}:${commit}`
}

const activities = proxyActivities<
	Pick<
		KodyActivities,
		| 'runPublishCheck'
		| 'storePackageBundle'
		| 'reindexPackage'
		| 'advancePublishedCommit'
	>
>({ startToCloseTimeout: '5 minutes' })

/**
 * `{userId}:publish:{packageId}`: checks in the code interpreter, owner
 * approval for a locked package, bundle to S3 by commit, reindex, and
 * `published_commit` last so readers never see a commit without its bundle.
 */
export async function PublishPackage(
	input: PublishPackageInput,
): Promise<{ publishedCommit: string; bundleKey: string }> {
	for (const check of publishChecks) {
		const result = await activities.runPublishCheck({ ...input, check })
		if (!result.ok) {
			throw ApplicationFailure.nonRetryable(
				`Publish check "${check}" failed: ${result.output}`,
				'PublishCheckFailed',
			)
		}
	}
	if (input.locked) {
		const decision = await executeChild(HumanApproval, {
			workflowId: workflowIds.humanApproval(
				input.userId,
				publishApprovalRequestId(input.packageId, input.commit),
			),
			taskQueue: taskQueues.app,
			args: [
				{
					userId: input.userId,
					requestId: publishApprovalRequestId(input.packageId, input.commit),
					kind: 'publish-lock',
				},
			],
		})
		if (!decision.approved) {
			throw ApplicationFailure.nonRetryable(
				'Publishing a locked package needs the owner’s approval.',
				'PublishApprovalMissing',
			)
		}
	}
	const { bundleKey } = await activities.storePackageBundle(input)
	await activities.reindexPackage(input)
	// ponytail: Schedule/webhook/subscription sync joins here when the repo publish path moves onto this workflow (P6).
	await activities.advancePublishedCommit({ ...input, bundleKey })
	return { publishedCommit: input.commit, bundleKey }
}
