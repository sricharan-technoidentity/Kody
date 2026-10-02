import { type AwsEnv } from '../aws/env.ts'

export async function executeRun(_input: {
	env: AwsEnv
	userId: string
	requestId: string
	code: string
}): Promise<{ workflowId: string; runId: string; result: string }> {
	throw new Error('not implemented: executeRun')
}
