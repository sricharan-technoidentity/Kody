import { type AwsEnv } from '../aws/env.ts'

export async function assertAccountAccess(input: {
	env: AwsEnv
	userId: string
	surface: 'front-door' | 'broker' | 'egress'
	account: { verified: boolean; suspended: boolean }
}): Promise<void> {
	if (input.userId !== input.env.userId)
		throw new Error('cross-user account access')
	if (!input.account.verified) throw new Error('email verification required')
	if (input.account.suspended) throw new Error('account suspended')
}
