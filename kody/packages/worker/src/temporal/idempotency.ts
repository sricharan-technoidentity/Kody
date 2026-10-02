import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'
import { type KodyTemporal } from './client.ts'
import { type KodyActivities } from './activities/types.ts'

/** Full encrypted result in S3, referenced by the 90-day DynamoDB claim. */
export function createWorkflowIdempotencyActivities(input: {
	idempotency: KodyTemporal['idempotency']
	results: KodyTemporal['results']
	kms: KmsEnvelope
	namespace: string
}): Pick<KodyActivities, 'completeWorkflowStart'> {
	return {
		async completeWorkflowStart({ result, ...claim }) {
			if (!input.idempotency)
				throw new Error('Missing workflow idempotency store.')
			if (!input.results) throw new Error('Missing workflow result store.')
			const json = JSON.stringify(result)
			const bytes = new TextEncoder().encode(json)
			const encrypted = await input.kms.encrypt(bytes, {
				userId: claim.userId,
				namespace: input.namespace,
			})
			const key = `${claim.userId}/temporal-results/${encodeURIComponent(claim.runId)}.json`
			await input.results.put(key, bytesToBase64Url(encrypted))
			await input.idempotency.completeIdempotencyKey({ ...claim, result: key })
		},
	}
}
