import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { type PgDatabase } from '#worker/aws/pg-database.ts'

export type McpCredentialVault = {
	get(userId: string, key: string): Promise<unknown>
	put(userId: string, key: string, value: unknown): Promise<void>
	delete(userId: string, key: string): Promise<void>
}

/** The POC's already-imported Identity fake; credentials never enter SQL. */
// ponytail: Identity token import uses the POC vault port; provider provisioning and consent bridge must replace this adapter before deployment.
export function createImportedMcpCredentialVault(vault: {
	store(userId: string, provider: string, token: string): void
	fetch(userId: string, provider: string, workload: string): string | undefined
}): McpCredentialVault {
	return {
		async get(userId, key) {
			const value = vault.fetch(userId, `mcp-client/${key}`, 'mcp-client')
			return value ? JSON.parse(value) : undefined
		},
		async put(userId, key, value) {
			vault.store(userId, `mcp-client/${key}`, JSON.stringify(value))
		},
		async delete(userId, key) {
			vault.store(userId, `mcp-client/${key}`, '')
		},
	}
}

type Registration = Record<string, string | null> & {
	id: string
	server_options: string | null
}

export async function createMcpClientStorage(input: {
	db: PgDatabase
	userId: string
	vault: McpCredentialVault
}) {
	if (!input.userId.trim()) throw new Error('MCP owner is required.')
	const { db, userId, vault } = input
	const owner = await db
		.prepare("SELECT current_setting('app.user_id', true) AS owner")
		.first<{ owner: string }>()
	if (owner?.owner !== userId) throw new Error('MCP database owner mismatch.')
	const sqlite = new DatabaseSync(':memory:')
	// ponytail: the installed MCP manager requires synchronous SQL; this ephemeral catalog is a compatibility cache, Aurora is durable. Replace when the SDK supports an async repository.
	sqlite.exec(`CREATE TABLE cf_agents_mcp_servers (
		id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, server_url TEXT NOT NULL,
		callback_url TEXT NOT NULL, client_id TEXT, auth_url TEXT, server_options TEXT
	)`)
	const initial = await db
		.prepare('SELECT version, rows_json FROM mcp_client_hubs WHERE user_id = ?')
		.bind(userId)
		.first<{ version: number; rows_json: string }>()
	let version = initial?.version ?? -1
	let headerIds = new Set(
		(JSON.parse(initial?.rows_json ?? '[]') as Registration[]).map(
			(row) => row.id,
		),
	)
	for (const row of JSON.parse(initial?.rows_json ?? '[]') as Registration[]) {
		const headers = await vault.get(userId, `headers/${row.id}`)
		if (headers && row.server_options) {
			const options = JSON.parse(row.server_options)
			options.transport = { ...options.transport, ...headers }
			row.server_options = JSON.stringify(options)
		}
		sqlite
			.prepare('INSERT INTO cf_agents_mcp_servers VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(
				row.id,
				row.name!,
				row.server_url!,
				row.callback_url!,
				row.client_id!,
				row.auth_url!,
				row.server_options,
			)
	}
	const credentialKey = (key: string) =>
		key.startsWith('/') || key.startsWith('mcp-oauth-refresh-token/')
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const statement = sqlite.prepare(query)
				const values = bindings as SQLInputValue[]
				if (/^\s*(SELECT|PRAGMA)/i.test(query)) return statement.all(...values)
				statement.run(...values)
				return []
			},
		},
		async get<T = unknown>(key: string): Promise<T | undefined> {
			const row = await db
				.prepare(
					'SELECT value_json, credential FROM mcp_client_values WHERE user_id = ? AND key = ?',
				)
				.bind(userId, key)
				.first<{ value_json: string | null; credential: number }>()
			if (!row) return undefined
			return (
				row.credential
					? await vault.get(userId, key)
					: JSON.parse(row.value_json!)
			) as T
		},
		async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
			for (const [key, entry] of Object.entries(
				typeof keyOrEntries === 'string'
					? { [keyOrEntries]: value }
					: keyOrEntries,
			)) {
				const credential = credentialKey(key)
				if (credential) await vault.put(userId, key, entry)
				await db
					.prepare(`INSERT INTO mcp_client_values (user_id, key, value_json, credential) VALUES (?, ?, ?, ?)
					ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, credential = excluded.credential`)
					.bind(
						userId,
						key,
						credential ? null : JSON.stringify(entry),
						credential ? 1 : 0,
					)
					.run()
			}
		},
		async list<T = unknown>(
			options: { prefix?: string } = {},
		): Promise<Map<string, T>> {
			const { results } = await db
				.prepare(
					'SELECT key FROM mcp_client_values WHERE user_id = ? ORDER BY key',
				)
				.bind(userId)
				.all<{ key: string }>()
			const entries = new Map<string, T>()
			for (const { key } of results)
				if (key.startsWith(options.prefix ?? ''))
					entries.set(key, (await storage.get<T>(key))!)
			return entries
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				if (credentialKey(key)) await vault.delete(userId, key)
				await db
					.prepare(
						'DELETE FROM mcp_client_values WHERE user_id = ? AND key = ?',
					)
					.bind(userId, key)
					.run()
			}
		},
		async deleteAll() {
			await storage.delete([...(await storage.list()).keys()])
			for (const row of sqlite
				.prepare('SELECT id FROM cf_agents_mcp_servers')
				.all())
				await vault.delete(userId, `headers/${row.id}`)
			sqlite.exec('DELETE FROM cf_agents_mcp_servers')
			await storage.flush()
		},
		async flush() {
			const rows = sqlite
				.prepare('SELECT * FROM cf_agents_mcp_servers ORDER BY id')
				.all() as Registration[]
			const nextIds = new Set(rows.map((row) => row.id))
			for (const id of headerIds)
				if (!nextIds.has(id)) await vault.delete(userId, `headers/${id}`)
			for (const row of rows) {
				if (!row.server_options) continue
				const options = JSON.parse(row.server_options)
				if (
					options.transport?.headers ||
					options.transport?.requestInit?.headers
				) {
					await vault.put(userId, `headers/${row.id}`, {
						headers: options.transport.headers,
						requestInit: options.transport.requestInit,
					})
					delete options.transport.headers
					delete options.transport.requestInit
				}
				row.server_options = JSON.stringify(options)
			}
			const result = await db
				.prepare(`INSERT INTO mcp_client_hubs (user_id, version, rows_json) VALUES (?, 0, ?)
				ON CONFLICT (user_id) DO UPDATE SET version = mcp_client_hubs.version + 1, rows_json = excluded.rows_json
				WHERE mcp_client_hubs.version = ? RETURNING version`)
				.bind(userId, JSON.stringify(rows), version)
				.first<{ version: number }>()
			if (!result)
				throw new Error(
					'MCP registration changed concurrently; retry the request.',
				)
			version = result.version
			headerIds = nextIds
		},
		close() {
			sqlite.close()
		},
	}
	return storage
}

export type McpClientStorage = Awaited<
	ReturnType<typeof createMcpClientStorage>
>
