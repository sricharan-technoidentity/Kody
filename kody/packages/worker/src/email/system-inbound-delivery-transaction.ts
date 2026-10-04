import { type SqlStatement } from '@kody-internal/shared/sql-database.ts'
import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { commitSystemEmailAuthorityBatch } from './system-email-authority.ts'

export type SystemInboundEventMutation = {
	eventId: string
	dedicated: SqlStatement
}

export async function commitSystemInboundEventMutations(input: {
	db: SqlDatabase
	mutations: ReadonlyArray<SystemInboundEventMutation>
	before?: ReadonlyArray<SqlStatement>
	after?: ReadonlyArray<SqlStatement>
}) {
	const beforeCount = input.before?.length ?? 0
	const results = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [
			...(input.before ?? []),
			...input.mutations.map((mutation) => mutation.dedicated),
			...(input.after ?? []),
		],
	})
	return {
		results,
		mutationResults: input.mutations.map((_mutation, index) => ({
			dedicated: results[beforeCount + index],
		})),
	}
}

export async function commitSystemInboundEventMutation(input: {
	db: SqlDatabase
	eventId: string
	dedicated: SqlStatement
	before?: ReadonlyArray<SqlStatement>
	after?: ReadonlyArray<SqlStatement>
}) {
	const { results, mutationResults } = await commitSystemInboundEventMutations({
		db: input.db,
		before: input.before,
		mutations: [
			{
				eventId: input.eventId,
				dedicated: input.dedicated,
			},
		],
		after: input.after,
	})
	return {
		results,
		dedicatedResult: mutationResults[0]?.dedicated,
	}
}
