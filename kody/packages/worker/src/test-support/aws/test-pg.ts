import { onTestFinished } from 'vitest'
import { createTestAuditDb } from './test-audit-db.ts'
import { createTestDb } from './test-db.ts'

/** The real PostgreSQL schema; lifetime belongs to the current test. */
export async function createTestPg() {
	const database = await createTestDb()
	onTestFinished(() => database[Symbol.asyncDispose]())
	return database.pg
}

export async function createTestAuditPg() {
	const database = await createTestAuditDb()
	onTestFinished(() => database[Symbol.asyncDispose]())
	return database.pg
}
