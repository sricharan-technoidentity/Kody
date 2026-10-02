import { type AwsEnv } from '../aws/env.ts'

export async function invokeCapability(_input: {
	env: AwsEnv
	runToken: string
	capability: string
	arguments: unknown
}): Promise<unknown> {
	throw new Error('not implemented: invokeCapability')
}
