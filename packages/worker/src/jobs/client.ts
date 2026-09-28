import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { jobsData, jobsService } from './jobs-data.ts'
import { type JobRepoCheckPolicy } from './types.ts'

/** Temporal-owned job operations routed through the jobs worker service. */
export async function purgeJobsForUser(input: { env: Env; userId: string }) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		// Tests may omit the jobs worker binding; still clear fallback rows.
		await jobsData(input.env).purgeUserJobsData({ userId: input.userId })
		return {
			ok: true as const,
			userId: input.userId,
			purged: false,
		}
	}
	return jobs.purgeUser({ userId: input.userId })
}

export async function runJobNowViaJobsService(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		throw new Error('Missing JOBS binding for job execution.')
	}
	return jobs.runJobNow({
		userId: input.userId,
		jobId: input.jobId,
		callerContext: input.callerContext ?? null,
		repoCheckPolicyOverride: input.repoCheckPolicyOverride,
	})
}
