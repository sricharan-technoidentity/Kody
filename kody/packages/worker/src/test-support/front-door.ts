import { type OutboundEmail } from '@kody-internal/shared/outbound-email.ts'
import { type KodyActivities } from '#worker/temporal/activities/types.ts'
import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { createRepoSessionCatalog } from '#worker/repo/repo-session-catalog.ts'
import { createMcpClients } from '#worker/mcp-client/service.ts'
import { createImportedMcpCredentialVault } from '#worker/mcp-client/storage.ts'
import { createFakeTokenVault } from './aws/fake-token-vault.ts'
import { createDynamoRealtimeSessions } from '#worker/aws/dynamo-realtime-sessions.ts'
import { createRepoServicesFake } from './repo-code-interpreter.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createDynamoKv } from '#worker/aws/dynamo-kv.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import { createTestObjectBucket } from './aws/fake-s3.ts'
import { createRunnerTestEnv } from './runner.ts'
import { createAwsEnv } from '#worker/front-door/env.ts'
import {
	createFrontDoor,
	type FetchHandler,
} from '#worker/front-door/handler.ts'
import { createDiskAssets } from '#worker/front-door/assets.ts'
import { createAppActivities } from '#worker/temporal/activities/app.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { getResponse } from 'msw'
import getPort from 'get-port'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createArtifactsMswHandlers } from './artifacts-msw-handlers.ts'

/** The POC's real Node/Temporal/workerd transport, with injected AWS service fakes. */
export async function createFrontDoorTestEnv(input: {
	handler: FetchHandler
	origin: string
	publicDirectory?: string
	temporalServer?: NonNullable<
		Parameters<typeof createRunnerTestEnv>[0]
	>['temporalServer']
	sourceFixture?: { fetch(request: Request): Promise<Response | undefined> }
	decorateActivities?: (
		activities: Partial<KodyActivities>,
	) => Partial<KodyActivities>
}) {
	const stack = new AsyncDisposableStack()
	try {
		const runner = await createRunnerTestEnv({
			restrictAdmin: true,
			temporalServer: input.temporalServer,
		})
		stack.defer(() => runner.close())
		const { pg } = runner
		const role = (
			name: Parameters<typeof createPgDatabase>[0]['role'],
			userId?: string,
			readOnly = false,
		) => createPgDatabase({ connection: pg, role: name, userId, readOnly })
		const outbox: Array<
			OutboundEmail & {
				id: string
			}
		> = []
		const mockPort = await getPort({ host: '127.0.0.1' })
		const mockOrigin = `http://127.0.0.1:${mockPort}`
		const handlers = createArtifactsMswHandlers({
			accountId: '000000000000',
			namespace: 'test',
			apiBaseUrl: mockOrigin,
			gitBaseUrl: `${mockOrigin}/git`,
		})
		const mock = await startFrontDoorServer({
			port: mockPort,
			async fetch(request) {
				const fixture = await input.sourceFixture?.fetch(request)
				if (fixture) return fixture
				return (
					(await getResponse(handlers, request)) ??
					new Response(null, { status: 404 })
				)
			},
		})
		stack.use(mock)
		const bindings = {
			...runner.env,
			COOKIE_SECRET: 'poc-cookie-secret-0123456789abcdef0123456789',
			APP_BASE_URL: input.origin,
			SENTRY_ENVIRONMENT: 'test',
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: '000000000000',
			CLOUDFLARE_API_TOKEN: 'mock-codecommit-contract-token',
			CLOUDFLARE_API_BASE_URL: mockOrigin,
			CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
			ARTIFACTS_NAMESPACE: 'test',
			OAUTH_KV: createDynamoKv({
				region: 'us-east-1',
				tableName: 'oauth',
				namespace: 'OAUTH_KV',
				send: createFakeDynamo().send,
			}),
			COMMUNITY_ASSETS: createTestObjectBucket().bucket,
			ASSETS: createDiskAssets(
				input.publicDirectory ?? 'packages/worker/public',
			),
			SES_MAIL: {
				async send(message: OutboundEmail) {
					const id = crypto.randomUUID()
					outbox.push({ ...structuredClone(message), id })
					return { messageId: id }
				},
			},
		} as Env
		const env = createAwsEnv({
			bindings,
			databases: {
				forUser: runner.forUser,
				community: role('kody_community'),
				admin: role('kody_admin'),
				adminReader: role('kody_admin', undefined, true),
				analytics: role('kody_analytics'),
				indexer: role('kody_indexer'),
				subjectReader: (owner) => role('kody_subject_reader', owner),
				subjectPurger: (owner) => role('kody_subject_purger', owner),
			},
		})
		const repos = createRepoServicesFake((owner) => env.forUser(owner, true))
		repos.interpreter.respondWith('typecheck', {
			ok: true,
			output: 'Local interpreter fixture: typecheck simulated.',
		})
		repos.interpreter.respondWith('lint', {
			ok: true,
			output: 'Local interpreter fixture: lint simulated.',
		})
		bindings.REPO_SESSION_SERVICES = repos.service
		const catalogDynamo = createFakeDynamo()
		bindings.REPO_SESSION_CATALOG = (ownerId) =>
			createRepoSessionCatalog({
				region: 'us-east-1',
				tableName: 'repo-sessions',
				ownerId,
				db: runner.forUser(ownerId).db as unknown as SqlDatabase,
				send: catalogDynamo.send,
				async cleanup(sessionId, reason) {
					return (
						await bindings.REPO_SESSION_SERVICES!(ownerId, sessionId)
					).cleanupSessionBranch({ userId: ownerId, sessionId, reason })
				},
			})
		bindings.MCP_CLIENTS = createMcpClients({
			forUser: (ownerId) => runner.forUser(ownerId).db,
			vault: createImportedMcpCredentialVault(
				createFakeTokenVault(['mcp-client']),
			),
			temporal: bindings.TEMPORAL,
		})
		bindings.REALTIME_SESSIONS = createDynamoRealtimeSessions({
			region: 'us-east-1',
			tableName: 'realtime',
			send: createFakeDynamo().send,
		})
		bindings.ACCOUNT_SUBJECT_READER = (ownerId) =>
			role('kody_subject_reader', ownerId)
		bindings.ACCOUNT_SUBJECT_PURGER = (ownerId) =>
			role('kody_subject_purger', ownerId)
		const door = createFrontDoor({
			env,
			temporal: bindings.TEMPORAL!,
			handler: input.handler,
		})
		const activities = { ...createAppActivities(bindings), ...door.activities }
		runner.target.setActivities(
			input.decorateActivities?.(activities) ?? activities,
		)
		const owned = stack.move()
		return {
			...door,
			env,
			pg,
			bindings,
			outbox,
			mockOrigin,
			restartWorkers: runner.target.restartWorkers,
			temporalAddress: runner.target.temporalAddress,
			async seedUser(user: {
				email: string
				username: string
				password: string
				admin?: boolean
			}) {
				const stableId = await createStableUserIdFromEmail(user.email)
				await pg.query(
					`INSERT INTO users (username, email, stable_user_id, password_hash, email_verified_at)
			 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
					[
						user.username,
						user.email,
						stableId,
						await createPasswordHash(user.password),
						new Date().toISOString(),
					],
				)
				await pg.query(
					`INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = $2 ON CONFLICT DO NOTHING`,
					[user.email, user.admin ? 'admin' : 'user'],
				)
			},
			close: () => owned.disposeAsync(),
		}
	} catch (error) {
		await stack.disposeAsync()
		throw error
	}
}
