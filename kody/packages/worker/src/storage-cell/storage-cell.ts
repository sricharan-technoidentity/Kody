import { type AwsEnv } from '../aws/env.ts'

export async function openStorageCell(_input: {
	env: AwsEnv
	userId: string
	storageId: string
	ownerId: string
}): Promise<{
	fencingToken: number
	sql(query: string, parameters?: unknown[]): Promise<unknown[][]>
}> {
	throw new Error('not implemented: openStorageCell')
}
