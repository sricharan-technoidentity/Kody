import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { createRepoSessionClient } from '#worker/repo/repo-session-client.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createPgSearchIndex } from '#worker/aws/pg-search-index.ts'
import { getUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import {
	setAuthSessionSecret,
	readParsedAuthSession,
	isAuthSessionExpired,
	isAuthSessionInvalidatedByPasswordChange,
} from '#app/auth-session.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'

export type RequestDatabases = {
	forUser(userId?: string): {
		db: PgDatabase
		reader: PgDatabase
		writerReader?: PgDatabase
	}
	community: PgDatabase
	admin: PgDatabase
	adminReader: PgDatabase
	analytics: PgDatabase
	indexer: PgDatabase
	subjectReader(userId: string): PgDatabase
	subjectPurger(userId: string): PgDatabase
}

/** Bind injected AWS adapters without opening any service connections. */
export function createAwsEnv(input: {
	bindings: Env
	databases: RequestDatabases
}) {
	const { bindings, databases } = input
	function forUser(
		userId: string | undefined,
		write: boolean,
		readAfterWrite = false,
	): Env {
		const db = databases.forUser(userId)
		return {
			...bindings,
			REQUEST_USER_ID: userId,
			REPO_SESSIONS:
				userId && bindings.TEMPORAL
					? (sessionId) =>
							createRepoSessionClient(bindings.TEMPORAL!, userId, sessionId)
					: undefined,
			APP_DB: (write
				? db.db
				: readAfterWrite
					? (db.writerReader ?? db.reader)
					: db.reader) as unknown as SqlDatabase,
			APP_DB_READER: db.reader,
			APP_DB_FOR_USER: (id: string) => {
				const scoped = databases.forUser(id)
				return write ? scoped.db : scoped.reader
			},
			COMMUNITY_DB: databases.community,
			ANALYTICS_DB: databases.analytics,
			ACCOUNT_SUBJECT_READER: (owner: string) => {
				if (owner !== userId) throw new Error('Account export owner mismatch.')
				return databases.subjectReader(owner)
			},
			ACCOUNT_SUBJECT_PURGER: write
				? (owner: string) => {
						if (owner !== userId)
							throw new Error('Account deletion owner mismatch.')
						return databases.subjectPurger(owner)
					}
				: undefined,
			SEARCH_INDEX: createPgSearchIndex({
				db: write ? databases.indexer : db.reader,
				reader: db.reader,
				userId: userId ?? '__kody_builtin__',
			}),
		} as Env
	}
	return {
		forUser,
		cookieSecret: bindings.COOKIE_SECRET,
		async forRequest(
			request: Request,
			write: boolean,
			readAfterWrite = false,
		): Promise<Env> {
			setAuthSessionSecret(bindings.COOKIE_SECRET)
			const parsed = await readParsedAuthSession(request)
			let userId = parsed?.session.stableUserId
			if (
				parsed &&
				isAuthSessionExpired({
					rememberMe: parsed.session.rememberMe,
					issuedAt: parsed.issuedAt,
				})
			)
				userId = undefined
			if (
				!userId &&
				request.headers.get('Authorization')?.startsWith('Bearer ')
			) {
				const helpers =
					await resolveOAuthHelpers<
						import('@cloudflare/workers-oauth-provider').OAuthHelpers
					>(bindings)
				const summary = await helpers?.unwrapToken(
					request.headers.get('Authorization')!.slice(7),
				)
				const owner = summary?.grant.props?.userId
				if (typeof owner === 'string') userId = owner
			}
			let env = forUser(userId, write, readAfterWrite)
			if (userId) {
				const user = await databases
					.forUser(userId)
					.reader.prepare(
						'SELECT id, password_changed_at FROM users WHERE stable_user_id = ?',
					)
					.bind(userId)
					.first<{ id: number; password_changed_at: string | null }>()
				if (
					!user ||
					(parsed &&
						isAuthSessionInvalidatedByPasswordChange({
							issuedAt: parsed.issuedAt,
							passwordChangedAtMs: user.password_changed_at
								? Date.parse(user.password_changed_at)
								: null,
						}))
				) {
					return forUser(undefined, write)
				}
				if (new URL(request.url).pathname.startsWith('/admin')) {
					const { roles } = await getUserRolesAndPermissions(
						env.APP_DB,
						user.id,
					)
					if (roles.includes('admin'))
						env = {
							...env,
							APP_DB: (write
								? databases.admin
								: databases.adminReader) as unknown as SqlDatabase,
						}
				}
			}
			return env
		},
	}
}
