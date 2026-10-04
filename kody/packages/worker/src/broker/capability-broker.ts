import { type AwsEnv } from '#worker/aws/env.ts'
import { verifyRunToken, type RunClaims } from '#worker/runner/run-token.ts'

/** Only the broker holds trusted dispatchers; requests never supply owner or provenance. */
export function createCapabilityBroker(input: {
	signingKey: string
	userId?: string
	dispatch(
		claims: RunClaims,
		capability: string,
		args: unknown,
	): Promise<unknown>
}) {
	return async (request: {
		runToken: string
		capability: string
		arguments: unknown
	}) => {
		const claims = await verifyRunToken(input.signingKey, request.runToken, {
			userId: input.userId,
		})
		if (
			typeof request.capability !== 'string' ||
			!request.capability ||
			request.capability.length > 200
		)
			throw new Error('Invalid capability.')
		if (
			claims.retriever &&
			![
				'storage.sql',
				'kody.storageGet',
				'kody.storageList',
				'kody.storageSql',
				'kody.packageStorageGet',
				'kody.packageStorageList',
				'kody.packageStorageSql',
			].includes(request.capability)
		)
			throw Object.assign(
				new Error(
					/packageStorage/i.test(request.capability)
						? 'packageStorage() is read-only during retriever runs. Persist writes from an export, job, or execute call.'
						: 'Storage is read-only during retriever runs.',
				),
				{ name: 'RetrieverCapabilityDenied' },
			)
		return input.dispatch(claims, request.capability, request.arguments)
	}
}

export async function invokeCapability(input: {
	env: AwsEnv
	runToken: string
	capability: string
	arguments: unknown
}): Promise<unknown> {
	return createCapabilityBroker({
		signingKey: input.env.RUN_TOKEN_SIGNING_KEY,
		userId: input.env.userId,
		async dispatch(claims, capability, args) {
			if (capability !== 'storage.sql')
				throw new Error(`Unknown capability: ${capability}`)
			if (!args || typeof args !== 'object')
				throw new Error('Invalid storage.sql arguments.')
			const { sql, parameters } = args as {
				sql?: unknown
				parameters?: unknown
			}
			if (
				typeof sql !== 'string' ||
				(parameters !== undefined && !Array.isArray(parameters))
			)
				throw new Error('Invalid storage.sql arguments.')
			const storageId = claims.provenance[0]!.storageId
			const cell = input.env.STORAGE_CELLS.forBucket({
				userId: claims.userId,
				storageId,
			})
			const result = await cell.sqlQuery({
				query: sql,
				params: parameters as Array<unknown> | undefined,
				writable: !claims.retriever,
			})
			return result.rows.map((row) =>
				result.columns.map((column) => row[column]),
			)
		},
	})(input)
}
