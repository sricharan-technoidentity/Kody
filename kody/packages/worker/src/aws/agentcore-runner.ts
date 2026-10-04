import { createHash } from 'node:crypto'
import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
	type InvokeAgentRuntimeResponse,
} from '@aws-sdk/client-bedrock-agentcore'

export function runnerSessionId(userId: string, rotationEpoch = 0) {
	if (!userId || !Number.isSafeInteger(rotationEpoch) || rotationEpoch < 0)
		throw new Error('Invalid Runner session owner or rotation epoch.')
	return createHash('sha256')
		.update(JSON.stringify([userId, rotationEpoch]))
		.digest('hex')
}

export function createAgentCoreRunner(input: {
	region: string
	runtimeArn: string
	send?: (
		command: InvokeAgentRuntimeCommand,
	) => Promise<Partial<InvokeAgentRuntimeResponse>>
}) {
	const client = input.send
		? undefined
		: new BedrockAgentCoreClient({ region: input.region })
	const send =
		input.send ??
		((command: InvokeAgentRuntimeCommand) => client!.send(command))
	return {
		async invoke(invocation: {
			runtimeSessionId: string
			payload: unknown
		}): Promise<unknown> {
			const payload = invocation.payload as {
				bundleKey?: unknown
				code?: unknown
				modules?: unknown
			}
			if (
				!payload ||
				typeof payload.bundleKey !== 'string' ||
				payload.code !== undefined ||
				payload.modules !== undefined
			)
				throw new Error(
					'Runner requires an S3 bundle reference, never bundle bytes.',
				)
			const result = await send(
				new InvokeAgentRuntimeCommand({
					agentRuntimeArn: input.runtimeArn,
					runtimeSessionId: invocation.runtimeSessionId,
					contentType: 'application/json',
					accept: 'application/json',
					payload: new TextEncoder().encode(JSON.stringify(payload)),
				}),
			)
			if (result.statusCode !== 200 || !result.response)
				throw new Error(
					`Runner invocation failed (${result.statusCode ?? 'missing status'}).`,
				)
			return JSON.parse(
				await new Response(result.response as BodyInit).text(),
			) as unknown
		},
	}
}
