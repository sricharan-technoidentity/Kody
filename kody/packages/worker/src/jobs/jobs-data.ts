import { type JobsServiceContract } from '@kody-internal/shared/jobs/rpc.ts'
import {
	createD1JobsStore,
	type JobsStore,
} from '@kody-internal/shared/jobs/store.ts'

/** The bindings {@link jobsData} needs; narrower than the full worker Env. */
export type JobsDataEnv = Pick<Env, 'JOBS' | 'APP_DB'>

/** Legacy test fixtures still provide a jobs-data RPC until their sandbox tests move in P6. */
export function jobsService(env: JobsDataEnv): JobsServiceContract | null {
	const jobs = env.JOBS
	if (!jobs) return null
	return jobs as unknown as JobsServiceContract
}

/** Aurora is authoritative; the retained data shim supports legacy sandbox fixtures. */
export function jobsData(env: JobsDataEnv): JobsStore {
	return jobsService(env) ?? createD1JobsStore(env.APP_DB)
}
