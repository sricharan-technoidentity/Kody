import assert from 'node:assert/strict'
import {
	BedrockAgentCoreClient,
	StartCodeInterpreterSessionCommand,
	InvokeCodeInterpreterCommand,
	StopCodeInterpreterSessionCommand,
	type ToolName,
	type ToolArguments,
	type CodeInterpreterResult,
} from '@aws-sdk/client-bedrock-agentcore'
import { randomUUID } from 'node:crypto'
import { PendingProof, type AwsProofConfig } from './aws-config.ts'

export async function proveInterpreter(config: AwsProofConfig) {
	if (!config.interpreter)
		throw new PendingProof(
			'Configure an existing Code Interpreter identifier with TypeScript checking available.',
		)
	const codeInterpreterIdentifier = config.interpreter.identifier
	const client = new BedrockAgentCoreClient({ region: config.region })
	let sessionId: string | undefined
	try {
		sessionId = (
			await client.send(
				new StartCodeInterpreterSessionCommand({
					codeInterpreterIdentifier,
					name: `poc-proof-${randomUUID()}`,
					clientToken: randomUUID(),
					sessionTimeoutSeconds: 300,
				}),
			)
		).sessionId
		assert(sessionId, 'Session identifier required')
		async function invoke(name: ToolName, args: ToolArguments) {
			const output = await client.send(
				new InvokeCodeInterpreterCommand({
					codeInterpreterIdentifier,
					sessionId,
					name,
					arguments: args,
				}),
			)
			let result: CodeInterpreterResult | undefined
			if (!output.stream)
				throw new Error('Interpreter response stream is required')
			for await (const event of output.stream) {
				if (!event.result) throw new Error('Interpreter stream failed')
				result = event.result
				if (result.isError) throw new Error('Interpreter tool failed')
			}
			assert(result, 'Interpreter result is required')
			return result
		}
		const path = 'poc-proof.ts'
		const source =
			'const report: string = "synthetic-poc"; console.log(report);\n'
		await invoke('writeFiles', { content: [{ path, text: source }] })
		const read = await invoke('readFiles', { paths: [path] })
		assert(
			read.content?.some(
				(block) =>
					block.text?.includes(source.trim()) ||
					block.resource?.text?.includes(source.trim()),
			),
			'Uploaded TypeScript fixture must round-trip',
		)
		const compiler = await invoke('executeCommand', {
			command:
				'if command -v tsc >/dev/null 2>&1; then printf tsc-available; else printf tsc-missing; fi',
		})
		if (compiler.structuredContent?.stdout?.trim() === 'tsc-missing')
			throw new PendingProof(
				'Existing interpreter must provide tsc; this proof does not install packages.',
			)
		assert.equal(
			compiler.structuredContent?.stdout?.trim(),
			'tsc-available',
			'Compiler prerequisite probe must return its marker',
		)
		const checked = await invoke('executeCommand', {
			command: 'tsc --noEmit --strict poc-proof.ts',
		})
		assert.equal(
			checked.structuredContent?.exitCode,
			0,
			'TypeScript check must succeed',
		)
		await invoke('writeFiles', {
			content: [{ path, text: 'const invalid: string = 123;\n' }],
		})
		// A compiler must also reject an intentionally invalid fixture.
		const rejected = await client.send(
			new InvokeCodeInterpreterCommand({
				codeInterpreterIdentifier,
				sessionId,
				name: 'executeCommand',
				arguments: { command: 'tsc --noEmit --strict poc-proof.ts' },
			}),
		)
		let exit: number | undefined
		for await (const event of rejected.stream ?? []) {
			if (event.result) exit = event.result.structuredContent?.exitCode
			else throw new Error('Interpreter stream failed')
		}
		assert(
			typeof exit === 'number' && exit !== 0,
			'TypeScript check must reject invalid types',
		)
		return {
			resource: codeInterpreterIdentifier,
			sessionId,
			fixtureRoundTrip: true,
			typecheckPassed: true,
			invalidTypesRejected: true,
			cleanup: 'session stopped',
		}
	} finally {
		try {
			if (sessionId)
				await client.send(
					new StopCodeInterpreterSessionCommand({
						codeInterpreterIdentifier,
						sessionId,
					}),
				)
		} finally {
			client.destroy()
		}
	}
}
