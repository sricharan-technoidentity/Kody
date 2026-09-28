import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { buildTemporalUserHash } from '@kody-internal/shared/temporal/identifiers.ts'

const artifactVersion = 1
const artifactPrefix = 'temporal-coordinator:v1:stripe-plan-refresh'
const coordinatorRefPattern =
	/^coordinator:stripe-plan-refresh\.([A-Za-z0-9_-]{32})$/

type StripePlanRefreshArtifact = {
	version: typeof artifactVersion
	ownerHash: string
	userId: string
}

function artifactKey(ownerHash: string) {
	return `${artifactPrefix}:${ownerHash}`
}

export async function storeStripePlanRefreshArtifact(input: {
	kv: KVNamespace
	userId: string
}) {
	const ownerHash = await buildTemporalUserHash(input.userId)
	const artifact: StripePlanRefreshArtifact = {
		version: artifactVersion,
		ownerHash,
		userId: input.userId,
	}
	await input.kv.put(artifactKey(ownerHash), canonicalJsonStringify(artifact))
	return {
		userHash: ownerHash,
		coordinatorRef: `coordinator:stripe-plan-refresh.${ownerHash}`,
	}
}

export async function loadStripePlanRefreshArtifact(input: {
	kv: KVNamespace
	coordinatorRef: string
	expectedOwnerHash: string
}) {
	const match = coordinatorRefPattern.exec(input.coordinatorRef)
	if (!match || match[1] !== input.expectedOwnerHash) {
		throw new Error('stripe_plan_refresh_artifact_owner_mismatch')
	}
	const serialized = await input.kv.get(artifactKey(input.expectedOwnerHash))
	if (!serialized) throw new Error('stripe_plan_refresh_artifact_not_found')
	const artifact = JSON.parse(serialized) as StripePlanRefreshArtifact
	if (
		artifact.version !== artifactVersion ||
		artifact.ownerHash !== input.expectedOwnerHash ||
		(await buildTemporalUserHash(artifact.userId)) !== input.expectedOwnerHash
	) {
		throw new Error('invalid_stripe_plan_refresh_artifact')
	}
	return artifact
}

export async function deleteStripePlanRefreshArtifact(input: {
	kv: KVNamespace
	userId: string
}) {
	const ownerHash = await buildTemporalUserHash(input.userId)
	await input.kv.delete(artifactKey(ownerHash))
}
