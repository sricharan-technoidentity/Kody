import { type AwsEnv } from '../aws/env.ts'

export async function assertAccountAccess(_input: {
	env: AwsEnv
	userId: string
	surface: 'front-door' | 'broker' | 'egress'
	account: { verified: boolean; suspended: boolean }
}): Promise<void> {
	throw new Error('not implemented: assertAccountAccess')
}
