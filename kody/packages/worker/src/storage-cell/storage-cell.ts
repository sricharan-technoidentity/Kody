import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { serialize, deserialize } from 'node:v8'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, constants, type SQLInputValue } from 'node:sqlite'
import { type AwsEnv } from '#worker/aws/env.ts'
import { type createDynamoLeases } from '#worker/aws/dynamo-leases.ts'

export function createStorageCells(input: {
	directory: string
	leases: ReturnType<typeof createDynamoLeases>
	reserveBytes(userId: string, bytes: number): Promise<() => Promise<void>>
}) {
	mkdirSync(input.directory, { recursive: true })
	const cellOwnerId = randomUUID()
	const openings = new Map<string, Promise<unknown>>()
	const buckets = new Map<
		string,
		{ db: DatabaseSync; tail: Promise<unknown> }
	>()
	const cells = {
		async open(key: { userId: string; storageId: string; ownerId: string }) {
			if (!key.userId || !key.storageId || !key.ownerId)
				throw new Error('Storage cell requires an owner and bucket.')
			const id = createHash('sha256')
				.update(JSON.stringify([key.userId, key.storageId]))
				.digest('hex')
			const opening = (openings.get(id) ?? Promise.resolve())
				.catch(() => {})
				.then(() => input.leases.acquire(key))
			openings.set(id, opening)
			const lease = await opening
			let bucket = buckets.get(id)
			if (!bucket) {
				bucket = {
					db: new DatabaseSync(join(input.directory, `${id}.sqlite`), {
						allowExtension: false,
						limits: { length: 10 * 1024 * 1024, sqlLength: 1024 * 1024 },
					}),
					tail: Promise.resolve(),
				}
				buckets.set(id, bucket)
			}
			const current = bucket
			async function query(
				sql: string,
				parameters: Array<unknown> = [],
				readOnly = false,
			) {
				const work = current.tail.then(async () => {
					await input.leases.assert({ ...key, ...lease })
					const db = current.db
					const params = parameters.map((value) => {
						if (
							value === null ||
							typeof value === 'string' ||
							(typeof value === 'number' && Number.isFinite(value)) ||
							value instanceof Uint8Array
						)
							return value as SQLInputValue
						throw new Error('Invalid storage SQL parameter.')
					})
					const size = () =>
						Number(db.prepare('PRAGMA page_count').get()!.page_count) *
						Number(db.prepare('PRAGMA page_size').get()!.page_size)
					const before = size()
					const changesBefore = Number(
						db.prepare('SELECT total_changes() AS changes').get()!.changes,
					)
					const refunds: Array<() => Promise<void>> = []
					let reserved = 0
					let mutated = false
					db.exec('BEGIN IMMEDIATE')
					try {
						let remaining = sql
						let columns: Array<string> = []
						let rows: Array<Record<string, unknown>> = []
						let rowsRead = 0
						let truncated = false
						while (
							remaining.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, '').trim()
						) {
							let writes = false
							let readsTable = false
							db.setAuthorizer((action, arg1) => {
								if (
									[
										constants.SQLITE_ATTACH,
										constants.SQLITE_DETACH,
										constants.SQLITE_TRANSACTION,
										constants.SQLITE_SAVEPOINT,
									].includes(action)
								)
									return constants.SQLITE_DENY
								if (
									action === constants.SQLITE_PRAGMA &&
									![
										'table_info',
										'index_list',
										'index_info',
										'database_list',
										'table_list',
									].includes(arg1 ?? '')
								)
									return constants.SQLITE_DENY
								if (action === constants.SQLITE_READ) readsTable = true
								if (
									![
										constants.SQLITE_READ,
										constants.SQLITE_SELECT,
										constants.SQLITE_FUNCTION,
										constants.SQLITE_PRAGMA,
										constants.SQLITE_RECURSIVE,
									].includes(action)
								)
									writes = true
								return writes && readOnly
									? constants.SQLITE_DENY
									: constants.SQLITE_OK
							})
							let statement
							try {
								statement = db.prepare(remaining)
							} finally {
								db.setAuthorizer(null)
							}
							remaining = remaining.slice(statement.sourceSQL.length)
							if (
								readOnly &&
								remaining
									.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, '')
									.trim()
							)
								throw new Error('Read-only storage SQL requires one statement.')
							if (writes && !mutated) {
								reserved =
									Buffer.byteLength(sql) +
									params.reduce<number>(
										(sum, value) =>
											sum +
											(value instanceof Uint8Array
												? value.byteLength
												: Buffer.byteLength(String(value))),
										0,
									)
								refunds.push(await input.reserveBytes(key.userId, reserved))
							}
							mutated ||= writes
							columns = statement.columns().map((column) => column.name)
							rows = []
							truncated = false
							// Bindings apply to the final statement, matching SqlStorage.exec's batch contract.
							for (const row of statement.iterate(
								...(remaining.trim() ? [] : params),
							)) {
								if (readsTable) rowsRead++
								if (rows.length < 1000) rows.push(row)
								else {
									truncated = true
									if (!writes) break
								}
							}
						}
						if (mutated && size() - before > reserved)
							refunds.push(
								await input.reserveBytes(
									key.userId,
									size() - before - reserved,
								),
							)
						await input.leases.assert({ ...key, ...lease })
						db.exec('COMMIT')
						return {
							columns,
							rows,
							rowCount: rows.length,
							rowsRead,
							rowsWritten:
								Number(
									db.prepare('SELECT total_changes() AS changes').get()!
										.changes,
								) - changesBefore,
							truncated,
						}
					} catch (error) {
						db.exec('ROLLBACK')
						for (const refund of refunds) await refund()
						throw error
					}
				})
				current.tail = work.catch(() => {})
				return work
			}
			return {
				...lease,
				async getEstimatedBytes() {
					await current.tail
					await input.leases.assert({ ...key, ...lease })
					return {
						estimatedBytes: Math.max(
							4096,
							Number(
								current.db.prepare('PRAGMA page_count').get()!.page_count,
							) *
								Number(current.db.prepare('PRAGMA page_size').get()!.page_size),
						),
					}
				},
				async getValue({ key: entryKey }: { key: string }) {
					await current.tail
					await input.leases.assert({ ...key, ...lease })
					if (
						!current.db
							.prepare("SELECT name FROM sqlite_master WHERE name = '_kody_kv'")
							.get()
					)
						return { key: entryKey, value: null }
					const row = await query(
						'SELECT value FROM _kody_kv WHERE key = ?',
						[entryKey],
						true,
					)
					return {
						key: entryKey,
						value: row.rows[0]
							? (deserialize(
									Buffer.from(row.rows[0].value as Uint8Array),
								) as unknown)
							: null,
					}
				},
				async setValue({
					key: entryKey,
					value,
				}: {
					key: string
					value: unknown
				}) {
					const normalizedKey = entryKey.trim()
					if (!normalizedKey)
						throw new Error('Storage key must be a non-empty string.')
					const bytes = serialize(structuredClone(value))
					await query(
						'CREATE TABLE IF NOT EXISTS _kody_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)',
					)
					await query(
						'INSERT INTO _kody_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
						[normalizedKey, bytes],
					)
					return { ok: true as const, key: normalizedKey }
				},
				async deleteValue({ key: entryKey }: { key: string }) {
					await current.tail
					await input.leases.assert({ ...key, ...lease })
					if (
						!current.db
							.prepare("SELECT name FROM sqlite_master WHERE name = '_kody_kv'")
							.get()
					)
						return { ok: true as const, key: entryKey, deleted: false }
					const result = await query('DELETE FROM _kody_kv WHERE key = ?', [
						entryKey,
					])
					return {
						ok: true as const,
						key: entryKey,
						deleted: result.rowsWritten > 0,
					}
				},
				async listValues(options: {
					prefix?: string | null
					pageSize?: number
					startAfter?: string | null
				}) {
					await input.leases.assert({ ...key, ...lease })
					await current.tail
					const pageSize = Math.min(
						1000,
						Math.max(
							1,
							Math.trunc(
								Number.isFinite(options.pageSize) ? options.pageSize! : 250,
							),
						),
					)
					const result = current.db
						.prepare("SELECT name FROM sqlite_master WHERE name = '_kody_kv'")
						.get()
						? await query(
								'SELECT key, value FROM _kody_kv WHERE substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?',
								[
									(options.prefix ?? '').length,
									options.prefix ?? '',
									options.startAfter ?? '',
									pageSize + 1,
								],
								true,
							)
						: { rows: [], truncated: false }
					const entries = result.rows.slice(0, pageSize).map((row) => ({
						key: String(row.key),
						value: deserialize(Buffer.from(row.value as Uint8Array)) as unknown,
					}))
					return {
						entries,
						pageSize,
						truncated: result.rows.length > pageSize || result.truncated,
						nextStartAfter:
							result.rows.length > pageSize || result.truncated
								? entries.at(-1)!.key
								: null,
						estimatedBytes: Math.max(
							4096,
							Number(
								current.db.prepare('PRAGMA page_count').get()!.page_count,
							) *
								Number(current.db.prepare('PRAGMA page_size').get()!.page_size),
						),
					}
				},
				release: () => input.leases.release({ ...key, ...lease }),
				sqlQuery: (
					sql: string,
					parameters?: Array<unknown>,
					readOnly?: boolean,
				) => query(sql, parameters, readOnly),
				async sql(
					sql: string,
					parameters?: Array<unknown>,
					readOnly?: boolean,
				): Promise<Array<Array<unknown>>> {
					const result = await query(sql, parameters, readOnly)
					return result.rows.map((row) =>
						result.columns.map((column) => row[column]),
					)
				},
			}
		},
		forBucket(key: { userId: string; storageId: string }) {
			const open = () => cells.open({ ...key, ownerId: cellOwnerId })
			return {
				getValue: async (payload: { key: string }) =>
					(await open()).getValue(payload),
				setValue: async (payload: { key: string; value: unknown }) =>
					(await open()).setValue(payload),
				deleteValue: async (payload: { key: string }) =>
					(await open()).deleteValue(payload),
				getEstimatedBytes: async () => (await open()).getEstimatedBytes(),
				listValues: async (payload: {
					prefix?: string | null
					pageSize?: number
					startAfter?: string | null
				}) => (await open()).listValues(payload),
				exportStorage: async (payload: {
					pageSize?: number
					startAfter?: string | null
				}) => (await open()).listValues(payload),
				async clearStorage() {
					const cell = await open()
					const tables = await cell.sql(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
						[],
						true,
					)
					for (const [table] of tables)
						await cell.sql(
							`DROP TABLE "${String(table).replaceAll('"', '""')}"`,
						)
					return { ok: true as const }
				},
				async importStorage(payload: {
					mode: 'replace'
					replacePage: 'first' | 'continue'
					entries: Array<{ key: string; valueJson: string }>
				}) {
					if (
						payload.mode !== 'replace' ||
						!['first', 'continue'].includes(payload.replacePage)
					)
						throw new Error('Invalid storage restore mode.')
					const entries = payload.entries.map((entry) => {
						const normalizedKey = entry.key.trim()
						if (!normalizedKey)
							throw new Error('Storage key must be a non-empty string.')
						try {
							return {
								key: normalizedKey,
								value: JSON.parse(entry.valueJson) as unknown,
							}
						} catch {
							throw new Error(
								`importStorage received invalid valueJson for key ${normalizedKey}`,
							)
						}
					})
					if (payload.replacePage === 'first')
						await cells.forBucket(key).clearStorage()
					const cell = await open()
					for (const entry of entries) await cell.setValue(entry)
					return {
						ok: true as const,
						written: entries.length,
						cleared: payload.replacePage === 'first',
					}
				},
				async sqlQuery(payload: {
					query: string
					params?: Array<unknown>
					writable?: boolean
				}) {
					const params = payload.params?.map((value) =>
						typeof value === 'boolean' ? Number(value) : value,
					)
					return (await open()).sqlQuery(
						payload.query,
						params,
						payload.writable !== true,
					)
				},
			}
		},
		async close() {
			for (const bucket of buckets.values()) {
				await bucket.tail
				bucket.db.close()
			}
			buckets.clear()
			openings.clear()
		},
	}
	return cells
}

export async function openStorageCell(input: {
	env: AwsEnv
	userId: string
	storageId: string
	ownerId: string
}) {
	return input.env.STORAGE_CELLS.open(input)
}
