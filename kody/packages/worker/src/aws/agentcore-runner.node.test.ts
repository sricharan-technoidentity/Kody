import { expect, test } from 'vitest'
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { createAgentCoreRunner, runnerSessionId } from './agentcore-runner.ts'

test('Runner SDK invocation uses owner-rotated sessions and object references', async () => {
	const commands: Array<InvokeAgentRuntimeCommand> = []
	const runner = createAgentCoreRunner({
		region: 'us-east-1',
		runtimeArn: 'mock-runtime',
		async send(command) {
			commands.push(command)
			return { statusCode: 200, response: new Response('{"output":1}').body! }
		},
	})
	const payload = {
		bundleKey: 'alice/bundles/pkg/commit.js',
		runToken: 'signed-token',
	}
	expect(
		await runner.invoke({
			runtimeSessionId: runnerSessionId('alice', 1),
			payload,
		}),
	).toEqual({ output: 1 })
	expect(commands[0]).toBeInstanceOf(InvokeAgentRuntimeCommand)
	expect(commands[0]?.input).toMatchObject({
		agentRuntimeArn: 'mock-runtime',
		contentType: 'application/json',
		runtimeSessionId: runnerSessionId('alice', 1),
	})
	expect(
		JSON.parse(new TextDecoder().decode(commands[0]?.input.payload)),
	).toEqual(payload)
	expect(runnerSessionId('alice', 1)).toHaveLength(64)
	expect(runnerSessionId('alice', 1)).not.toBe(runnerSessionId('bob', 1))
	expect(runnerSessionId('alice', 1)).not.toBe(runnerSessionId('alice', 2))
	await expect(
		runner.invoke({
			runtimeSessionId: runnerSessionId('alice'),
			payload: { code: 'secret source bytes' },
		}),
	).rejects.toThrow('reference')
})
