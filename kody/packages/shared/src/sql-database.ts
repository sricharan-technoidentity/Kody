export type SqlResult<T> = {
	success: boolean
	results: Array<T>
	meta: { changes: number }
}
export type SqlStatement = {
	bind(...values: unknown[]): SqlStatement
	all<T = Record<string, unknown>>(): Promise<SqlResult<T>>
	first<T = Record<string, unknown>>(column?: string): Promise<T | null>
	run<T = Record<string, unknown>>(): Promise<SqlResult<T>>
}
export type SqlDatabase = {
	transaction?<T>(run: (db: SqlDatabase) => Promise<T>): Promise<T>
	prepare(sql: string): SqlStatement
	batch<T = Record<string, unknown>>(
		statements: SqlStatement[],
	): Promise<SqlResult<T>[]>
}
