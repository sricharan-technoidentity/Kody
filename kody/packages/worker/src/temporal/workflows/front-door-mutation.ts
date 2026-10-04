import { proxyActivities } from '@temporalio/workflow'
import { type ExposureInput } from '../../feature-flags/exposure.ts'
import {
	type HttpRequestPayload,
	type HttpResponsePayload,
} from '../../front-door/http-payload.ts'
const { handleHttpMutation } = proxyActivities<{
	handleHttpMutation(input: HttpRequestPayload): Promise<HttpResponsePayload>
}>({
	startToCloseTimeout: '2 minutes',
	// Existing HTTP handlers do not all have retry-safe effects. Never replay a partial form automatically.
	retry: { maximumAttempts: 1 },
})
export async function FrontDoorMutation(
	input: HttpRequestPayload,
): Promise<HttpResponsePayload> {
	return handleHttpMutation(input)
}

const { recordExposure } = proxyActivities<{
	recordExposure(input: ExposureInput): Promise<void>
}>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } })
export async function FeatureFlagExposure(input: ExposureInput) {
	await recordExposure(input)
}

export type McpClientOperation = {
	userId: string
	method: string
	args: unknown[]
}
const { operateMcpClient } = proxyActivities<{
	operateMcpClient(input: McpClientOperation): Promise<unknown>
}>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 1 } })
export async function FrontDoorMcpOperation(input: McpClientOperation) {
	return operateMcpClient(input)
}
