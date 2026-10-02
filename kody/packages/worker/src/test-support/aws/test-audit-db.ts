import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createPgDatabase } from '#worker/aws/pg-database.ts'

let template: Promise<Blob> | undefined
async function schemaTemplate() {
	const pg = new PGlite()
	try {
		const directory = new URL('../../../audit-migrations-pg/', import.meta.url)
		for (const name of (await readdir(directory))
			.filter((name) => name.endsWith('.sql'))
			.sort()) {
			await pg.exec(await readFile(new URL(name, directory), 'utf8'))
		}
		return await pg.dumpDataDir()
	} finally {
		await pg.close()
	}
}

export async function createTestAuditDb() {
	template ??= schemaTemplate()
	const pg = new PGlite({ loadDataDir: await template })
	await pg.waitReady
	return {
		pg,
		db: createPgDatabase({ connection: pg, role: 'kody_audit_writer' }),
		reader: createPgDatabase({ connection: pg, role: 'kody_audit_reader' }),
		[Symbol.asyncDispose]: () => pg.close(),
	}
}
