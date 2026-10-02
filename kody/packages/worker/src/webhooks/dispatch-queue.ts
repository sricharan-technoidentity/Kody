import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import {
	deleteWebhookDispatchPayload,
	hydrateWebhookDispatchQueueMessage,
} from './dispatch-payload-store.ts'
import { type WebhookDispatchQueueMessage } from './dispatch-queue-producer.ts'
import {
	buildWebhookCallerIdempotencyHashParams,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import { stripUntrustedWebhookSyntheticFields } from './synthetic.ts'

const retryableInvocationErrorCodes = new Set([
	'idempotency_lookup_failed',
	'idempotency_persistence_failed',
	'invocation_in_progress',
])

function resolveWebhookDispatchInvocation(
	message: WebhookDispatchQueueMessage,
):
	| {
			ok: true
			params: Record<string, unknown>
			idempotencyHashParams?: Record<string, unknown>
	  }
	| { ok: false; code: 'invalid_params' } {
	if (message.inputMode === 'params') {
		const resolved = resolveWebhookParamsModeFirstArg(
			message.params.request.json,
		)
		if (!resolved.ok) return resolved
		return {
			ok: true,
			params: stripUntrustedWebhookSyntheticFields(resolved.params),
		}
	}
	return {
		ok: true,
		params: message.params,
		...(message.callerIdempotency
			? {
					idempotencyHashParams: buildWebhookCallerIdempotencyHashParams({
						json: message.params.request.json,
						bodyText: message.params.request.body,
					}),
				}
			: {}),
	}
}

function readInvocationErrorCode(body: unknown): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' ? code : null
}

export async function processWebhookDispatch(
	message: WebhookDispatchQueueMessage,
	env: Env,
): Promise<'terminal' | 'retry'> {
	const resolved = resolveWebhookDispatchInvocation(message)
	if (!resolved.ok) {
		await recordWebhookDelivery({
			env,
			endpoint: message.endpoint,
			kodyId: message.packageKodyId,
			outcome: 'rejected',
			httpStatus: 400,
			error: resolved.code,
			payloadBytes: message.payloadBytes,
			invocationId: message.deliveryId,
			startedAt: message.receivedAt,
			requirePersistence: true,
		})
		return 'terminal'
	}
	const response = await dispatchWebhookInvocation({
		env,
		endpoint: message.endpoint,
		packageKodyId: message.packageKodyId,
		exportName: message.exportName,
		params: resolved.params,
		idempotencyKey: message.idempotencyKey,
		...(message.idempotencyParamsHash === 'ignore'
			? { idempotencyParamsHash: 'ignore' as const }
			: {}),
		...(resolved.idempotencyHashParams
			? { idempotencyHashParams: resolved.idempotencyHashParams }
			: {}),
	})
	const errorCode = readInvocationErrorCode(response.body)
	if (errorCode && retryableInvocationErrorCodes.has(errorCode)) return 'retry'

	const ok = response.status >= 200 && response.status < 300
	await recordWebhookDelivery({
		env,
		endpoint: message.endpoint,
		kodyId: message.packageKodyId,
		outcome: ok ? 'delivered' : 'failed',
		httpStatus: ok ? 202 : 502,
		error: ok ? null : `invocation_status_${response.status}`,
		payloadBytes: message.payloadBytes,
		invocationId: message.deliveryId,
		result: readWebhookInvocationResult(response.body),
		startedAt: message.receivedAt,
		requirePersistence: true,
	})
	return 'terminal'
}

/**
 * One acknowledged webhook delivery (the production `invokePackage`
 * activity of a `WebhookDelivery` workflow): hydrate a spilled payload,
 * invoke, record, then drop the spilled payload.
 */
export async function handleWebhookDispatchMessage(
	message: WebhookDispatchQueueMessage,
	env: Env,
): Promise<'ack' | 'retry'> {
	try {
		const hydrated = await hydrateWebhookDispatchQueueMessage({
			message,
			kv: env.BUNDLE_ARTIFACTS_KV,
		})
		if (!hydrated) {
			console.error('webhook-dispatch-payload-missing', {
				endpointId: message.endpoint.id,
				deliveryId: message.deliveryId,
			})
			try {
				await recordWebhookDelivery({
					env,
					endpoint: message.endpoint,
					kodyId: message.packageKodyId,
					outcome: 'failed',
					httpStatus: 502,
					error: 'ack_queue_payload_missing',
					payloadBytes: message.payloadBytes,
					invocationId: message.deliveryId,
					startedAt: message.receivedAt,
					requirePersistence: true,
				})
			} catch (error) {
				console.error('webhook-dispatch-payload-missing-record-failed', {
					endpointId: message.endpoint.id,
					error,
				})
				return 'retry'
			}
			return 'ack'
		}
		const outcome = await processWebhookDispatch(hydrated, env)
		if (outcome === 'retry') return 'retry'
		if (message.payloadKvKey) {
			await deleteWebhookDispatchPayload({
				kv: env.BUNDLE_ARTIFACTS_KV,
				key: message.payloadKvKey,
			}).catch((error) => {
				console.error('webhook-dispatch-payload-delete-failed', {
					endpointId: message.endpoint.id,
					error,
				})
			})
		}
		return 'ack'
	} catch (error) {
		console.error('webhook-dispatch-queue-processing-failed', {
			endpointId: message.endpoint.id,
			error,
		})
		return 'retry'
	}
}
