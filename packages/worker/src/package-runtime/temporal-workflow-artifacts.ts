import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { buildTemporalUserHash } from '@kody-internal/shared/temporal/identifiers.ts'
import { type DynamicCallableWorkflowPayload } from './package-workflows.ts'

const artifactVersion = 1
const artifactPrefix = 'temporal-workflow-artifact'
const artifactRefPattern =
	/^artifact:(workflow-source|workflow-caller)\.([A-Za-z0-9_-]{32})@([a-f0-9]{64})$/

type WorkflowSourcePayload<T = DynamicCallableWorkflowPayload> =
	T extends unknown ? Omit<T, 'userId' | 'packageContext'> : never

type WorkflowSourceArtifact = {
	version: typeof artifactVersion
	ownerHash: string
	payload: WorkflowSourcePayload
}

type WorkflowCallerArtifact = {
	version: typeof artifactVersion
	ownerHash: string
	userId: string
	packageContext: Extract<
		DynamicCallableWorkflowPayload,
		{ sourceType: 'inline' }
	>['packageContext']
}

type ArtifactKind = 'workflow-source' | 'workflow-caller'

function artifactKvKey(input: {
	kind: ArtifactKind
	ownerHash: string
	hash: string
}) {
	return [
		artifactPrefix,
		`v${String(artifactVersion)}`,
		input.ownerHash,
		input.kind,
		input.hash,
	].join(':')
}

async function writeArtifact(input: {
	kv: KVNamespace
	kind: ArtifactKind
	ownerHash: string
	value: WorkflowSourceArtifact | WorkflowCallerArtifact
	expiresAt: number
}) {
	const serialized = canonicalJsonStringify(input.value)
	const hash = await sha256Hex(serialized)
	await input.kv.put(
		artifactKvKey({ kind: input.kind, ownerHash: input.ownerHash, hash }),
		serialized,
		{ expiration: input.expiresAt },
	)
	return `artifact:${input.kind}.${input.ownerHash}@${hash}`
}

function parseArtifactRef(ref: string, expectedKind: ArtifactKind) {
	const match = artifactRefPattern.exec(ref)
	if (!match || match[1] !== expectedKind) {
		throw new Error('invalid_workflow_artifact_ref')
	}
	return { ownerHash: match[2]!, hash: match[3]! }
}

async function readArtifact(input: {
	kv: KVNamespace
	ref: string
	kind: ArtifactKind
	expectedOwnerHash: string
}) {
	const parsed = parseArtifactRef(input.ref, input.kind)
	if (parsed.ownerHash !== input.expectedOwnerHash) {
		throw new Error('workflow_artifact_owner_mismatch')
	}
	const serialized = await input.kv.get(
		artifactKvKey({
			kind: input.kind,
			ownerHash: parsed.ownerHash,
			hash: parsed.hash,
		}),
	)
	if (!serialized || (await sha256Hex(serialized)) !== parsed.hash) {
		throw new Error('workflow_artifact_not_found')
	}
	const value = JSON.parse(serialized) as
		| WorkflowSourceArtifact
		| WorkflowCallerArtifact
	if (
		value.version !== artifactVersion ||
		value.ownerHash !== input.expectedOwnerHash
	) {
		throw new Error('invalid_workflow_artifact')
	}
	return value
}

export async function storeTemporalWorkflowArtifacts(input: {
	kv: KVNamespace
	payload: DynamicCallableWorkflowPayload
}) {
	const ownerHash = await buildTemporalUserHash(input.payload.userId)
	const expiresAt = Math.floor(
		(Math.max(Date.now(), Date.parse(input.payload.runAt)) +
			31 * 24 * 60 * 60_000) /
			1000,
	)
	const sourcePayload: WorkflowSourcePayload =
		input.payload.sourceType === 'inline'
			? (({ userId: _userId, packageContext: _packageContext, ...payload }) =>
					payload)(input.payload)
			: (({ userId: _userId, ...payload }) => payload)(input.payload)
	const sourceRef = await writeArtifact({
		kv: input.kv,
		kind: 'workflow-source',
		ownerHash,
		value: {
			version: artifactVersion,
			ownerHash,
			payload: sourcePayload,
		} as WorkflowSourceArtifact,
		expiresAt,
	})
	const callerContextRef = await writeArtifact({
		kv: input.kv,
		kind: 'workflow-caller',
		ownerHash,
		value: {
			version: artifactVersion,
			ownerHash,
			userId: input.payload.userId,
			packageContext:
				input.payload.sourceType === 'inline'
					? input.payload.packageContext
					: null,
		},
		expiresAt,
	})
	return { ownerHash, sourceRef, callerContextRef }
}

export async function loadTemporalWorkflowPayload(input: {
	kv: KVNamespace
	userHash: string
	sourceRef: string
	callerContextRef: string
}): Promise<DynamicCallableWorkflowPayload> {
	const [source, caller] = await Promise.all([
		readArtifact({
			kv: input.kv,
			ref: input.sourceRef,
			kind: 'workflow-source',
			expectedOwnerHash: input.userHash,
		}),
		readArtifact({
			kv: input.kv,
			ref: input.callerContextRef,
			kind: 'workflow-caller',
			expectedOwnerHash: input.userHash,
		}),
	])
	if (!('payload' in source) || !('userId' in caller)) {
		throw new Error('invalid_workflow_artifact')
	}
	if ((await buildTemporalUserHash(caller.userId)) !== input.userHash) {
		throw new Error('workflow_artifact_owner_mismatch')
	}
	const payload = source.payload
	return payload.sourceType === 'inline'
		? {
				...payload,
				userId: caller.userId,
				packageContext: caller.packageContext,
			}
		: { ...payload, userId: caller.userId }
}

export async function loadTemporalWorkflowOwner(input: {
	kv: KVNamespace
	userHash: string
	callerContextRef: string
}) {
	const caller = await readArtifact({
		kv: input.kv,
		ref: input.callerContextRef,
		kind: 'workflow-caller',
		expectedOwnerHash: input.userHash,
	})
	if (!('userId' in caller)) throw new Error('invalid_workflow_artifact')
	if ((await buildTemporalUserHash(caller.userId)) !== input.userHash) {
		throw new Error('workflow_artifact_owner_mismatch')
	}
	return caller.userId
}
