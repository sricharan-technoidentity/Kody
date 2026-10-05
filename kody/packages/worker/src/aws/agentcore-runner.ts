import {
	parseRunnerInvocation,
	runnerInputKey,
	runnerSessionId,
} from '#worker/runner/contract.ts'
export { runnerSessionId } from '#worker/runner/contract.ts'
import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
	type InvokeAgentRuntimeResponse,
} from '@aws-sdk/client-bedrock-agentcore'

export function createAgentCoreRunner(input: {
	region: string
	runtimeArn: string
	send?: (
		command: InvokeAgentRuntimeCommand,
		options?: { abortSignal?: AbortSignal },
	) => Promise<Partial<InvokeAgentRuntimeResponse>>
}) {
	const client = input.send
		? undefined
		: new BedrockAgentCoreClient({ region: input.region, maxAttempts: 1 })
	const send =
		input.send ??
		((
			command: InvokeAgentRuntimeCommand,
			options?: { abortSignal?: AbortSignal },
		) => client!.send(command, options))
	return {
		async invoke(invocation: {
			runtimeSessionId: string
			payload: unknown
			signal?: AbortSignal
			timeoutMs?: number
		}): Promise<unknown> {
			const payload = parseRunnerInvocation(invocation.payload)
			const owner = payload.bundleKey.split('/')[0]!
			if (
				payload.bundleKey !== runnerInputKey(owner, payload.runId) ||
				invocation.runtimeSessionId !== runnerSessionId(owner, payload.runId)
			)
				throw new Error(
					'Runner session must match the referenced owner and run.',
				)
			const result = await send(
				new InvokeAgentRuntimeCommand({
					agentRuntimeArn: input.runtimeArn,
					runtimeSessionId: invocation.runtimeSessionId,
					contentType: 'application/json',
					accept: 'application/json',
					payload: new TextEncoder().encode(JSON.stringify(payload)),
				}),
				{
					abortSignal: AbortSignal.any([
						AbortSignal.timeout(invocation.timeoutMs ?? 90_000),
						...(invocation.signal ? [invocation.signal] : []),
					]),
				},
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
