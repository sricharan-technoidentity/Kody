import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageCells } from '#worker/storage-cell/storage-cell.ts'
import { createDynamoLeases } from '#worker/aws/dynamo-leases.ts'
import { createDynamoUserMeters } from '#worker/aws/dynamo-meters.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createRepoSessionServices } from '#worker/repo/repo-session-service.ts'
import { Workspace } from '#worker/repo/code-interpreter-workspace.ts'
import { createRepoCodeInterpreterFake } from './repo-code-interpreter.ts'
import { createTestDb } from './aws/test-db.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
} from '#worker/storage-buckets/service.ts'
import { type RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'

export async function createStorageTestEnv() {
	const database = await createTestDb({ userId: 'user-123' })
	const directory = await mkdtemp(join(tmpdir(), 'kody-storage-test-'))
	const dynamo = createFakeDynamo()
	const reservations = new Map<string, number>()
	const cells = createStorageCells({
		directory,
		leases: createDynamoLeases({
			region: 'us-east-1',
			tableName: 'leases',
			send: dynamo.send,
		}),
		async reserveBytes(userId, bytes) {
			// This fixture has an unlimited cell allowance; wrapper tests enforce real account plans.
			reservations.set(userId, (reservations.get(userId) ?? 0) + bytes)
			return async () => {
				reservations.set(userId, reservations.get(userId)! - bytes)
			}
		},
	})
	let owner = 'user-123'
	const interpreter = createRepoCodeInterpreterFake()
	const env = {
		APP_DB: database.db,
		APP_DB_FOR_USER: (userId: string) => database.forUser(userId).db,
		USER_METERS: createDynamoUserMeters({
			region: 'us-east-1',
			tableName: 'meters',
			send: dynamo.send,
		}),
		STORAGE_CELLS: cells,
		REPO_SESSION_BLOBS: {
			list: async () => ({ objects: [], truncated: false }),
		},
		REPO_SESSIONS: (sessionId: string) =>
			new Proxy({} as RepoSessionRpc, {
				get(_target, method: keyof RepoSessionRpc) {
					return async (payload: unknown) =>
						(await services(owner, sessionId))[method](payload as never)
				},
			}),
	} as unknown as Env
	const services = createRepoSessionServices({
		forUser: (userId) => ({ ...env, APP_DB: database.forUser(userId).db }),
		session: interpreter.session,
	})
	clearStorageBucketRegistrationDedupeForTests()
	return {
		env,
		database,
		reservations,
		scope(userId: string) {
			owner = userId
			env.APP_DB = database.forUser(userId).db
			return env
		},
		operator() {
			return {
				...env,
				APP_DB: createPgDatabase({
					connection: database.pg,
					role: 'kody_admin',
				}),
			}
		},
		async seedRepoSession(sessionId: string) {
			const workspace = new Workspace(interpreter.session(owner, sessionId))
			await workspace.mkdir('/session', { recursive: true })
			await workspace.writeFile('/session/fixture.txt', 'workspace data')
		},
		async [Symbol.asyncDispose]() {
			await flushStorageBucketRegistrationsForTests()
			await cells.close()
			await database[Symbol.asyncDispose]()
			await rm(directory, { recursive: true, force: true })
		},
	}
}
