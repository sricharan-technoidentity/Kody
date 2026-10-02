import {
	type Payload,
	type PayloadCodec,
	type SerializationContext,
} from '@temporalio/common'
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'

export const kodyKmsEncoding = 'binary/kody-kms'

const text = new TextEncoder()
const decodeText = new TextDecoder()

/**
 * The owner a workflow id belongs to: the leading `userId` of user
 * workflows, the user inside `job:{userId}:…` Schedules, and the leading
 * segment otherwise (endpoint id, topic, `lane`, `queue`).
 */
export function workflowIdOwner(workflowId: string) {
	const [first = '', second = ''] = workflowId.split(':')
	return first === 'job' ? second : first
}

function contextOwner(context: SerializationContext | undefined) {
	return context?.workflowId ? workflowIdOwner(context.workflowId) : ''
}

/**
 * Encrypts every Temporal payload with a KMS data key before it leaves the
 * account. The encryption context is `{ namespace, userId }`, where `userId`
 * is the owner of the workflow the payload belongs to (from the SDK's
 * serialization context), so a payload copied into another user's history
 * fails to decrypt. Metadata keeps the owner in clear text, like the
 * `KodyUserId` search attribute.
 */
export function createKodyPayloadCodec(input: {
	kms: KmsEnvelope
	namespace: string
}): PayloadCodec {
	return {
		async encode(payloads, context) {
			const userId = contextOwner(context)
			return Promise.all(
				payloads.map(async (payload): Promise<Payload> => {
					const plain = text.encode(
						JSON.stringify({
							metadata: Object.fromEntries(
								Object.entries(payload.metadata ?? {}).map(([key, value]) => [
									key,
									bytesToBase64Url(value),
								]),
							),
							data: bytesToBase64Url(payload.data ?? new Uint8Array()),
						}),
					)
					return {
						metadata: {
							encoding: text.encode(kodyKmsEncoding),
							'kody-user-id': text.encode(userId),
						},
						data: await input.kms.encrypt(plain, {
							namespace: input.namespace,
							userId,
						}),
					}
				}),
			)
		},
		async decode(payloads, context) {
			return Promise.all(
				payloads.map(async (payload): Promise<Payload> => {
					const encoding = payload.metadata?.encoding
					if (!encoding || decodeText.decode(encoding) !== kodyKmsEncoding) {
						return payload
					}
					const userId = decodeText.decode(
						payload.metadata?.['kody-user-id'] ?? new Uint8Array(),
					)
					const expected = contextOwner(context)
					if (context?.workflowId && expected !== userId) {
						throw new Error('Temporal payload owner does not match workflow.')
					}
					const plain = await input.kms.decrypt(
						payload.data ?? new Uint8Array(),
						{ namespace: input.namespace, userId },
					)
					const parsed = JSON.parse(decodeText.decode(plain)) as {
						metadata: Record<string, string>
						data: string
					}
					return {
						metadata: Object.fromEntries(
							Object.entries(parsed.metadata).map(([key, value]) => [
								key,
								base64UrlToBytes(value),
							]),
						),
						data: base64UrlToBytes(parsed.data),
					}
				}),
			)
		},
	}
}
