import {
	BedrockRuntimeClient,
	InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'

export type EmbeddingPort = {
	embedTexts(texts: readonly string[]): Promise<number[][]>
}

export function createBedrockEmbeddings(input: {
	region: string
	modelId?: string
	invoke?: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }>
}): EmbeddingPort {
	const client = input.invoke
		? undefined
		: new BedrockRuntimeClient({ region: input.region })
	const invoke =
		input.invoke ?? ((command: InvokeModelCommand) => client!.send(command))
	return {
		async embedTexts(texts) {
			// Titan accepts one text per request. The port preserves batch order.
			return Promise.all(
				texts.map(async (inputText) => {
					const response = await invoke(
						new InvokeModelCommand({
							modelId: input.modelId ?? 'amazon.titan-embed-text-v2:0',
							contentType: 'application/json',
							accept: 'application/json',
							body: JSON.stringify({
								inputText,
								dimensions: 1024,
								normalize: true,
							}),
						}),
					)
					const payload = JSON.parse(
						new TextDecoder().decode(response.body),
					) as { embedding?: unknown }
					if (
						!Array.isArray(payload.embedding) ||
						payload.embedding.length !== 1024 ||
						payload.embedding.some(
							(value) => typeof value !== 'number' || !Number.isFinite(value),
						)
					) {
						throw new Error(
							'Bedrock embedding must have 1024 finite dimensions',
						)
					}
					return payload.embedding as number[]
				}),
			)
		},
	}
}
