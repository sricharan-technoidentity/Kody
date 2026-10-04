import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { type RepoSessionIndexRpc } from './repo-session-catalog.ts'

export type RepoSessionIndexEnv = {
	REPO_SESSION_CATALOG?: (ownerId: string) => RepoSessionIndexRpc
	APP_DB: SqlDatabase
}

export function repoSessionIndexNamespace(env: RepoSessionIndexEnv) {
	return env.REPO_SESSION_CATALOG ?? null
}

export function repoSessionIndexRpc(input: {
	env: RepoSessionIndexEnv
	userId: string
}): RepoSessionIndexRpc {
	const catalog = repoSessionIndexNamespace(input.env)
	if (!catalog) throw new Error('REPO_SESSION_CATALOG is not configured.')
	return catalog(input.userId)
}

export type { RepoSessionIndexRpc }
