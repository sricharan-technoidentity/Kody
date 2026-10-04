import { readFile } from 'node:fs/promises'

export type AwsProofConfig = {
	region: string
	postgres?: { urlEnvironment: string }
	dynamo?: { metersTable: string; idempotencyTable: string; runsTable: string }
	s3?: { bucket: string }
	kms?: { keyId: string }
	runtime?: {
		arn: string
		compatibleWorkerdHost: boolean
		invocationFile: string
		sessionId: string
		expectedResult: unknown
	}
	interpreter?: { identifier: string }
	identity?: {
		workload: string
		userId: string
		provider: string
		scopes?: Array<string>
	}
	embeddings?: { modelId?: string }
	ses?: { from: string }
}
export async function readAwsConfig(
	path = process.env.KODY_DEMO_AWS_CONFIG,
): Promise<AwsProofConfig | undefined> {
	if (!path) return undefined
	const config = JSON.parse(await readFile(path, 'utf8')) as AwsProofConfig
	if (!config.region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(config.region))
		throw new Error('AWS proof configuration requires a region.')
	if (
		process.env.AWS_ACCESS_KEY_ID === 'AKIAIOSFODNN7EXAMPLE' ||
		process.env.AWS_SECRET_ACCESS_KEY?.includes('EXAMPLEKEY')
	)
		throw new Error(
			'Example credentials are forbidden in AWS proof mode. Start a separate shell using the AWS credential provider chain.',
		)
	return config
}
export class PendingProof extends Error {}
