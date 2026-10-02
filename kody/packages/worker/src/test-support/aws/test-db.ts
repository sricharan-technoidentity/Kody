import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { createPgDatabase } from '#worker/aws/pg-database.ts'

let template: Promise<Blob> | undefined
async function schemaTemplate() {
	const pg = new PGlite({ extensions: { vector } })
	try {
		const directory = fileURLToPath(
			new URL('../../../migrations-pg/', import.meta.url),
		)
		for (const name of (await readdir(directory))
			.filter((name) => name.endsWith('.sql'))
			.sort()) {
			await pg.exec(
				await readFile(
					new URL(`../../../migrations-pg/${name}`, import.meta.url),
					'utf8',
				),
			)
		}
		return await pg.dumpDataDir()
	} finally {
		await pg.close()
	}
}

export async function createTestDb(options: { userId?: string } = {}) {
	template ??= schemaTemplate()
	const pg = new PGlite({ extensions: { vector }, loadDataDir: await template })
	await pg.waitReady
	function forUser(userId?: string) {
		return {
			db: createPgDatabase({ connection: pg, role: 'kody_writer', userId }),
			reader: createPgDatabase({ connection: pg, role: 'kody_reader', userId }),
		}
	}
	return {
		pg,
		...forUser(options.userId),
		forUser,
		[Symbol.asyncDispose]: () => pg.close(),
	}
}
