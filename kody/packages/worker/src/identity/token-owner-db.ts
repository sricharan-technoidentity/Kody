import { type PgDatabase, type SqlDatabase } from '#worker/aws/pg-database.ts'

const ownerResolvers = {
	password_reset: 'kody_password_reset_owner',
	email_verification: 'kody_email_verification_owner',
	email_change: 'kody_email_change_owner',
	email_claim_release: 'kody_email_claim_release_owner',
	passkey: 'kody_passkey_owner',
	account_email: 'kody_account_email_owner',
	oauth_connection: 'kody_oauth_connection_owner',
} as const

export type AccountWriterFactory = (stableUserId: string) => PgDatabase

/** Per-account writer factory that request environments bind beside `APP_DB`. */
export function getAccountWriterFactory(
	env: Pick<Env, 'APP_DB'>,
): AccountWriterFactory | undefined {
	// ponytail: legacy Env has no APP_DB_FOR_USER; P7's AwsEnv builds it from createPgPools().forUser.
	return (env as { APP_DB_FOR_USER?: AccountWriterFactory }).APP_DB_FOR_USER
}

/**
 * A per-account view of an operator environment: fleet sweeps list accounts
 * through the operator's `APP_DB`, then read and write each account's rows
 * through that account's writer. Legacy bindings reuse `env`.
 */
export function getAccountEnv<E extends Pick<Env, 'APP_DB'>>(
	env: E,
	stableUserId: string,
): E {
	const forUser = getAccountWriterFactory(env)
	return forUser ? { ...env, APP_DB: forUser(stableUserId) } : env
}

/**
 * The writer for an account a signed-out request just created: on PostgreSQL
 * that account's scoped writer, on legacy bindings the shared database.
 */
export function getNewAccountDb(
	env: Pick<Env, 'APP_DB'>,
	stableUserId: string,
): D1Database | PgDatabase {
	const db = env.APP_DB as D1Database | PgDatabase
	if (!('dialect' in db && db.dialect === 'postgres')) return db
	const forUser = getAccountWriterFactory(env)
	if (!forUser)
		throw new Error('signup needs the new account writer on PostgreSQL')
	return forUser(stableUserId)
}

/**
 * Links opened before sign-in carry only a token (passkey sign-in: only a
 * credential id; login and reset requests: only an email). On PostgreSQL a
 * definer maps that key to the owner and the flow continues on that owner's
 * scoped writer; `null` means no such row. Legacy bindings keep using the
 * shared database.
 */
export async function resolveTokenOwnerDb<T extends SqlDatabase>(input: {
	db: T
	forUser?: (stableUserId: string) => T
	kind: keyof typeof ownerResolvers
	/** One value, or several for multi-column keys (provider, provider id). */
	key: string | ReadonlyArray<string>
}): Promise<T | null> {
	if (!('dialect' in input.db && input.db.dialect === 'postgres')) {
		return input.db
	}
	if (!input.forUser) {
		throw new Error(
			`${input.kind} needs the token owner's writer on PostgreSQL`,
		)
	}
	const key = typeof input.key === 'string' ? [input.key] : input.key
	const row = await input.db
		.prepare(
			`SELECT ${ownerResolvers[input.kind]}(${key.map(() => '?').join(', ')}) AS owner`,
		)
		.bind(...key)
		.first<{ owner: string | null }>()
	return row?.owner ? input.forUser(row.owner) : null
}
