import { type AwsEnv } from '../aws/env.ts'

export async function egressFetch(_input: {
	env: AwsEnv
	runToken: string
	url: string
	requiredHosts: string[]
	allowlist: string[]
}): Promise<Response> {
	throw new Error('not implemented: egressFetch')
}
