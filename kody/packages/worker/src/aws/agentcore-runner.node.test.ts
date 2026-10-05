import { expect, test } from 'vitest'
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { createAgentCoreRunner, runnerSessionId } from './agentcore-runner.ts'

test('Runner SDK invocation enforces owner/run sessions and object references', async () => {
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
		bundleKey: 'alice/runner-inputs/one.json',
		runToken: 'signed-token',
		runId: 'one',
	}
	expect(
		await runner.invoke({
			runtimeSessionId: runnerSessionId('alice', 'one'),
			payload,
		}),
	).toEqual({ output: 1 })
	expect(commands[0]).toBeInstanceOf(InvokeAgentRuntimeCommand)
	expect(commands[0]?.input).toMatchObject({
		agentRuntimeArn: 'mock-runtime',
		contentType: 'application/json',
		runtimeSessionId: runnerSessionId('alice', 'one'),
	})
	expect(
		JSON.parse(new TextDecoder().decode(commands[0]?.input.payload)),
	).toEqual(payload)
	expect(runnerSessionId('alice', 'one')).toHaveLength(64)
	expect(runnerSessionId('alice', 'one')).not.toBe(
		runnerSessionId('bob', 'one'),
	)
	expect(runnerSessionId('alice', 'one')).not.toBe(
		runnerSessionId('alice', 'two'),
	)
	for (const runtimeSessionId of [
		runnerSessionId('bob', 'one'),
		runnerSessionId('alice', 'two'),
	])
		await expect(runner.invoke({ runtimeSessionId, payload })).rejects.toThrow(
			'owner and run',
		)
	expect(commands).toHaveLength(1)
	await expect(
		runner.invoke({
			runtimeSessionId: runnerSessionId('alice', 'one'),
			payload: { code: 'secret source bytes' },
		}),
	).rejects.toThrow('reference')
})
