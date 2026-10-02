import { type AwsEnv } from '../aws/env.ts'

export async function handleFrontDoorRequest(_input: {
	env: AwsEnv
	userId: string
	request: Request
	readAfterWrite?: boolean
}): Promise<Response> {
	throw new Error('not implemented: handleFrontDoorRequest')
}
