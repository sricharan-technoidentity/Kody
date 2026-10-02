import { expect, test } from 'vitest'
import { createBedrockEmbeddings } from './bedrock-embeddings.ts'

test('Bedrock embedding port sends Titan requests, preserves order, validates output and propagates provider failures', async () => {
	const calls: unknown[] = []
	const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
	const port = createBedrockEmbeddings({
		region: 'us-east-1',
		invoke: async (command) => {
			calls.push(command.input)
			return {
				body: new TextEncoder().encode(JSON.stringify({ embedding: vector })),
			}
		},
	})
	expect(await port.embedTexts([])).toEqual([])
	expect(await port.embedTexts(['alpha', 'beta'])).toEqual([vector, vector])
	expect(calls).toEqual(
		['alpha', 'beta'].map((inputText) => ({
			modelId: 'amazon.titan-embed-text-v2:0',
			contentType: 'application/json',
			accept: 'application/json',
			body: JSON.stringify({ inputText, dimensions: 1024, normalize: true }),
		})),
	)
	const invalid = createBedrockEmbeddings({
		region: 'us-east-1',
		invoke: async () => ({
			body: new TextEncoder().encode('{"embedding":[1,2]}'),
		}),
	})
	await expect(invalid.embedTexts(['alpha'])).rejects.toThrow('dimensions')
	const failed = createBedrockEmbeddings({
		region: 'us-east-1',
		invoke: async () => {
			throw new Error('unavailable')
		},
	})
	await expect(failed.embedTexts(['alpha'])).rejects.toThrow('unavailable')
})
