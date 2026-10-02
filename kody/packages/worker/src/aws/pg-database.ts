import { type PGlite } from '@electric-sql/pglite'
import { Pool } from 'pg'

type PgRole =
	| 'kody_writer'
	| 'kody_reader'
	| 'kody_admin'
	| 'kody_analytics'
	| 'kody_community'
	| 'kody_indexer'
	| 'kody_audit_writer'
	| 'kody_audit_reader'
	| 'kody_subject_reader'
	| 'kody_subject_purger'
	| 'kody_retention'
	| 'kody_audit_retention'
const readOnlyRoles = new Set<PgRole>([
	'kody_reader',
	'kody_audit_reader',
	'kody_analytics',
	'kody_community',
	'kody_subject_reader',
])
type QueryResult = { rows: Record<string, unknown>[]; affectedRows?: number }
type Queryable = {
	query(sql: string, values?: unknown[]): Promise<QueryResult>
}
type TransactionRunner = <T>(run: (tx: Queryable) => Promise<T>) => Promise<T>
const statementOwner = Symbol('statement database')
type Prepared = {
	[statementOwner]: object
	values: unknown[]
	_execute(tx: Queryable): Promise<QueryResult>
}

/** Replace only bind markers, preserving SQL literals, identifiers and comments. */
function parameters(sql: string) {
	let result = ''
	let count = 0
	let index = 0
	while (index < sql.length) {
		const start = index
		const char = sql[index]!
		if (char === "'" || char === '"') {
			index++
			while (index < sql.length) {
				if (sql[index++] === char) {
					if (sql[index] === char) index++
					else break
				}
			}
		} else if (sql.startsWith('--', index)) {
			index = sql.indexOf('\n', index)
			if (index < 0) index = sql.length
		} else if (sql.startsWith('/*', index)) {
			index += 2
			let depth = 1
			while (index < sql.length && depth > 0) {
				if (sql.startsWith('/*', index)) {
					depth++
					index += 2
				} else if (sql.startsWith('*/', index)) {
					depth--
					index += 2
				} else index++
			}
		} else if (
			char === '$' &&
			/^\$(?:[a-z_][a-z_0-9]*)?\$/i.test(sql.slice(index))
		) {
			const tag = sql.slice(index).match(/^\$(?:[a-z_][a-z_0-9]*)?\$/i)![0]
			const end = sql.indexOf(tag, index + tag.length)
			index = end < 0 ? sql.length : end + tag.length
		} else if (char === ';' && sql.slice(index + 1).trim()) {
			throw new Error('only one prepared statement is allowed')
		} else if (char === '?') {
			// SQLite `?NNN` reuses bind NNN, exactly like PostgreSQL `$NNN`.
			const numbered = /^\?(\d+)/.exec(sql.slice(index))
			result += numbered ? `$${numbered[1]}` : `$${++count}`
			index += numbered ? numbered[0].length : 1
			continue
		} else index++
		result += sql.slice(start, index)
	}
	return result
}

function safeSql(sql: string) {
	// Transaction/session control belongs to the host, never a prepared caller.
	if (
		!/^\s*(select|insert|update|delete|with|values|explain)\b/i.test(sql) ||
		/\bset_config\s*\(/i.test(sql)
	) {
		throw new Error('session and schema control is not allowed in prepared SQL')
	}
	return parameters(sql)
}

function parseInt8(value: string) {
	const number = Number(value)
	if (!Number.isSafeInteger(number))
		throw new Error('Postgres integer exceeds JavaScript safe integer range')
	return number
}

function facade(
	input: { runTransaction: TransactionRunner; role: PgRole; userId?: string },
	pinned?: Queryable,
): PgDatabase {
	const owner = {}
	async function transaction<T>(run: (tx: Queryable) => Promise<T>) {
		if (pinned) return run(pinned)
		return input.runTransaction(async (tx) => {
			await tx.query(`SET LOCAL ROLE ${input.role}`)
			if (readOnlyRoles.has(input.role))
				await tx.query('SET TRANSACTION READ ONLY')
			await tx.query("SELECT set_config('app.user_id', $1, true)", [
				input.userId ?? '',
			])
			return run(tx)
		})
	}
	function prepare(sql: string) {
		const query = safeSql(sql)
		function statement(values: unknown[]) {
			const execute = (tx: Queryable) => tx.query(query, values)
			return {
				[statementOwner]: owner,
				query,
				values,
				_execute: execute,
				bind: (...bound: unknown[]) => statement(bound),
				async all<T = Record<string, unknown>>() {
					const result = await transaction(execute)
					return {
						success: true,
						results: result.rows as T[],
						meta: { changes: result.affectedRows ?? 0 },
					}
				},
				async first<T = Record<string, unknown>>(
					column?: string,
				): Promise<T | null> {
					const row = (await transaction(execute)).rows[0]
					return (column ? (row?.[column] ?? null) : (row ?? null)) as T | null
				},
				async raw<T = unknown>(): Promise<T[][]> {
					return (await transaction(execute)).rows.map((row) =>
						Object.values(row),
					) as T[][]
				},
				async run<T = Record<string, unknown>>() {
					const result = await transaction(execute)
					return {
						success: true,
						results: result.rows as T[],
						meta: { changes: result.affectedRows ?? 0 },
					}
				},
			}
		}
		return statement([])
	}
	return {
		dialect: 'postgres',
		prepare,
		async batch<T = Record<string, unknown>>(statements: Prepared[]) {
			if (statements.some((statement) => statement[statementOwner] !== owner))
				throw new Error('statement belongs to another database')
			return transaction(async (tx) => {
				const results = []
				for (const statement of statements) {
					const result = await statement._execute(tx)
					results.push({
						success: true,
						results: result.rows as T[],
						meta: { changes: result.affectedRows ?? 0 },
					})
				}
				return results
			})
		},
		transaction<T>(run: (db: PgDatabase) => Promise<T>) {
			return transaction((tx) => run(facade(input, tx)))
		},
	}
}

// ponytail: D1-shaped facade keeps existing prepare/bind callers; replace with typed queries later.
type PgResult<T> = { success: boolean; results: T[]; meta: { changes: number } }
type PgStatement = Prepared & {
	bind(...values: unknown[]): PgStatement
	all<T = Record<string, unknown>>(): Promise<PgResult<T>>
	first<T = Record<string, unknown>>(column?: string): Promise<T | null>
	raw<T = unknown>(): Promise<T[][]>
	run<T = Record<string, unknown>>(): Promise<PgResult<T>>
}
// Public query shape shared by migrated services and legacy bindings during P3.
type SqlStatement = {
	bind(...values: unknown[]): SqlStatement
	all<T = Record<string, unknown>>(): Promise<PgResult<T>>
	first<T = Record<string, unknown>>(column?: string): Promise<T | null>
	run<T = Record<string, unknown>>(): Promise<PgResult<T>>
}
export type SqlDatabase = {
	transaction?<T>(run: (db: SqlDatabase) => Promise<T>): Promise<T>
	prepare(sql: string): SqlStatement
	batch<T = Record<string, unknown>>(
		statements: SqlStatement[],
	): Promise<PgResult<T>[]>
}
export type PgDatabase = {
	dialect: 'postgres'
	prepare(sql: string): PgStatement
	batch<T = Record<string, unknown>>(
		statements: PgStatement[],
	): Promise<PgResult<T>[]>
	transaction<T>(run: (db: PgDatabase) => Promise<T>): Promise<T>
}

export function createPgDatabase(input: {
	connection: Pick<PGlite, 'transaction'>
	role: PgRole
	userId?: string
}): PgDatabase {
	return facade({
		...input,
		runTransaction: (run) =>
			input.connection.transaction((tx) =>
				run({
					query: (sql, values) =>
						tx.query(sql, values, { parsers: { 20: parseInt8 } }),
				}),
			),
	})
}

/** One checked-out client owns the entire transaction, including the RLS context. */
export function createPgPoolDatabase(input: {
	pool: Pool
	role: PgRole
	userId?: string
}): PgDatabase {
	return facade({
		...input,
		async runTransaction(run) {
			const client = await input.pool.connect()
			try {
				await client.query('BEGIN')
				const result = await run({
					async query(sql, values) {
						const result = await client.query(sql, values)
						const rows = result.rows.map((row) =>
							Object.fromEntries(
								Object.entries(row as Record<string, unknown>).map(
									([key, value]) => [
										key,
										result.fields.find((field) => field.name === key)
											?.dataTypeID === 20 && typeof value === 'string'
											? parseInt8(value)
											: value,
									],
								),
							),
						)
						return { rows, affectedRows: result.rowCount ?? 0 }
					},
				})
				await client.query('COMMIT')
				return result
			} catch (error) {
				await client.query('ROLLBACK')
				throw error
			} finally {
				client.release()
			}
		},
	})
}

export function createPgPools(input: { writerUrl: string; readerUrl: string }) {
	const writer = new Pool({ connectionString: input.writerUrl })
	const reader = new Pool({ connectionString: input.readerUrl })
	return {
		forUser(userId: string) {
			if (!userId.trim()) throw new Error('userId is required')
			return {
				APP_DB: createPgPoolDatabase({
					pool: writer,
					role: 'kody_writer',
					userId,
				}),
				APP_DB_READER: createPgPoolDatabase({
					pool: reader,
					role: 'kody_reader',
					userId,
				}),
			}
		},
		async close() {
			await Promise.all([writer.end(), reader.end()])
		},
	}
}

/** Dedicated audit connections: runtime append and authorized operator query. */
export function createPgAuditPools(input: {
	writerUrl: string
	readerUrl: string
}) {
	const writer = new Pool({ connectionString: input.writerUrl })
	const reader = new Pool({ connectionString: input.readerUrl })
	return {
		AUDIT_DB: createPgPoolDatabase({ pool: writer, role: 'kody_audit_writer' }),
		AUDIT_DB_READER: createPgPoolDatabase({
			pool: reader,
			role: 'kody_audit_reader',
		}),
		async close() {
			await Promise.all([writer.end(), reader.end()])
		},
	}
}
