import { sha256Base64Url } from '../sha256.ts'

const identifierPartPattern = /^[A-Za-z0-9._~:-]{1,200}$/

export function assertOpaqueTemporalIdentifier(value: string, label: string) {
	if (!identifierPartPattern.test(value)) {
		throw new Error(`${label} must be a bounded opaque identifier.`)
	}
	return value
}

async function hashParts(parts: ReadonlyArray<string>) {
	return (await sha256Base64Url(parts.join('\u001f'))).slice(0, 32)
}

export async function buildTemporalUserHash(userId: string) {
	return await hashParts(['user', userId])
}

export async function buildTemporalJobHash(userId: string, jobId: string) {
	return await hashParts(['job', userId, jobId])
}

export async function buildJobScheduleId(userId: string, jobId: string) {
	return `kody-job-v1:${await hashParts([userId, jobId])}`
}

export async function buildJobOccurrenceWorkflowId(
	userId: string,
	jobId: string,
	scheduledFor: string,
) {
	return `kody-job-occ-v1:${await hashParts([userId, jobId, scheduledFor])}`
}

/**
 * Temporal Schedule actions append their scheduled timestamp to this base ID.
 * The resulting execution ID is unique per occurrence without exposing either
 * the user or job identifier.
 */
export async function buildJobOccurrenceWorkflowBaseId(
	userId: string,
	jobId: string,
) {
	return `kody-job-occ-v1:${await hashParts([userId, jobId])}`
}

export async function buildPackageWorkflowId(
	userId: string,
	workflowRunId: string,
) {
	return `kody-package-v1:${await hashParts([userId, workflowRunId])}`
}

export async function buildStripePlanRefreshWorkflowId(userId: string) {
	return `kody-stripe-plan-refresh-v1:${await hashParts([userId])}`
}
