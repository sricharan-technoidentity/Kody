import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { PendingProof, type AwsProofConfig } from './aws-config.ts'

/** All rows are inside a rolled-back transaction against the existing schema. */
export async function provePostgres(
	config: AwsProofConfig,
	embedding?: Array<number>,
) {
	const url = config.postgres && process.env[config.postgres.urlEnvironment]
	if (!url)
		throw new PendingProof(
			'Configure postgres.urlEnvironment with an existing sandbox PostgreSQL login allowed to SET ROLE kody_writer and kody_reader.',
		)
	const pool = new Pool({
		connectionString: url,
		connectionTimeoutMillis: 10000,
		statement_timeout: 15000,
		max: 1,
	})
	const db = await pool.connect().catch(async (error: unknown) => {
		await pool.end()
		throw error
	})
	const owner = `poc-proof-${randomUUID()}`
	const id = randomUUID()
	try {
		await db.query('BEGIN')
		const tables = await db.query(
			"SELECT to_regclass('mcp_memories') AS memories, to_regclass('search_vectors') AS vectors",
		)
		assert(
			tables.rows[0].memories && tables.rows[0].vectors,
			'Existing Kody schema is required.',
		)
		await db.query('SET LOCAL ROLE kody_writer')
		await db.query("SELECT set_config('app.user_id',$1,true)", [owner])
		await db.query(
			'INSERT INTO mcp_memories (id,user_id,subject,summary) VALUES ($1,$2,$3,$4)',
			[id, owner, 'Synthetic POC proof', 'Disposable synthetic memory'],
		)
		const vector =
			embedding ??
			Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))
		await db.query(
			'INSERT INTO search_vectors (user_id,id,embedding) VALUES ($1,$2,$3::vector)',
			[owner, id, JSON.stringify(vector)],
		)
		const near = await db.query(
			'SELECT id FROM search_vectors WHERE user_id=$1 ORDER BY embedding <=> $2::vector LIMIT 1',
			[owner, JSON.stringify(vector)],
		)
		assert.equal(near.rows[0]?.id, id)
		await db.query('SET LOCAL ROLE kody_reader')
		await db.query("SELECT set_config('app.user_id',$1,true)", [`${owner}-bob`])
		assert.equal(
			(await db.query('SELECT id FROM mcp_memories WHERE id=$1', [id])).rows
				.length,
			0,
		)
		assert.equal(
			(await db.query('SELECT id FROM search_vectors WHERE id=$1', [id])).rows
				.length,
			0,
		)
		await db.query("SELECT set_config('app.user_id',$1,true)", [owner])
		assert.equal(
			(await db.query('SELECT id FROM mcp_memories WHERE id=$1', [id])).rows
				.length,
			1,
		)
		await db.query('SAVEPOINT reader_write')
		let denied = false
		try {
			await db.query('UPDATE mcp_memories SET summary=$1 WHERE id=$2', [
				'Must be refused',
				id,
			])
		} catch (error) {
			if ((error as { code?: string }).code === '42501') denied = true
			else throw error
		} finally {
			await db.query('ROLLBACK TO SAVEPOINT reader_write')
		}
		assert(denied, 'Reader must reject writes')
		return {
			resource: new URL(url).hostname,
			schema: 'mcp_memories/search_vectors',
			ownerRls: true,
			readerWriteRejected: true,
			vectorDimensions: vector.length,
			cleanup: 'transaction rollback',
		}
	} finally {
		try {
			await db.query('ROLLBACK')
		} finally {
			db.release()
			await pool.end()
		}
	}
}
