import { createTestObjectBucket } from './aws/fake-s3.ts'
import { createTestRunRecords } from './run-records.ts'
import { createDynamoInvocationLedger } from '#worker/aws/dynamo-invocation-ledger.ts'
import { createRunState } from '#worker/temporal/run-state.ts'
import { createMailboxService } from '#worker/email/mailbox-service.ts'
import { createServer } from 'node:http'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createDynamoKv } from '#worker/aws/dynamo-kv.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import { createTargetTestEnv } from './aws/target-test-env.ts'
import { createTestDb } from './aws/test-db.ts'
import { createInMemoryUserMeterEnv } from './user-meter.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { createEgressHandler } from '#worker/egress/egress-proxy.ts'
import { createRunnerLoader } from '#worker/runner/loader.ts'
import {
	startWorkerdRunner,
	type RunnerGraph,
} from '#worker/runner/supervisor.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { runnerSessionId } from '#worker/aws/agentcore-runner.ts'

/** Native package compatibility harness: real workerd, broker, PostgreSQL and SQLite. */
export async function createRunnerTestEnv(
	options: {
		restrictAdmin?: boolean
		temporalServer?: NonNullable<
			Parameters<typeof createTargetTestEnv>[0]
		>['temporalServer']
	} = {},
) {
	const stack = new AsyncDisposableStack()
	try {
		const target = await createTargetTestEnv({
			temporalServer: options.temporalServer,
		})
		stack.defer(() => target.close())
		const database = await createTestDb()
		stack.use(database)
		if (!options.restrictAdmin)
			await database.pg.exec(
				'GRANT ALL ON ALL TABLES IN SCHEMA public TO kody_admin; ALTER ROLE kody_admin BYPASSRLS',
			)
		const signingKey = target.env.RUN_TOKEN_SIGNING_KEY
		const broker = createBrokerHandler({ signingKey })
		const egress = createEgressHandler({
			signingKey,
			forUser(userId) {
				return { ...target.env, userId, APP_DB: database.forUser(userId).db }
			},
		})
		const server = createServer(async (request, response) => {
			try {
				const bytes: Array<Buffer> = []
				for await (const byte of request) bytes.push(Buffer.from(byte))
				const headers = new Headers()
				for (const [key, value] of Object.entries(request.headers))
					if (value)
						headers.set(key, Array.isArray(value) ? value.join(',') : value)
				const isBroker = request.headers.host === 'broker.internal'
				const body = ['GET', 'HEAD'].includes(request.method ?? '')
					? undefined
					: Buffer.concat(bytes)
				const url = isBroker
					? 'https://broker.internal/'
					: `http://${request.headers.host}${request.url}`
				const result = await (isBroker ? broker : egress).fetch(
					new Request(url, { method: request.method, headers, body }),
				)
				response.writeHead(result.status, Object.fromEntries(result.headers))
				response.end(Buffer.from(await result.arrayBuffer()))
			} catch (error) {
				response.writeHead(500)
				response.end(String(error))
			}
		})
		stack.defer(
			() => new Promise<void>((resolve) => server.close(() => resolve())),
		)
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		const address = server.address() as { port: number }
		const graphs = new Map<string, RunnerGraph>()
		const runner = await startWorkerdRunner({
			brokerUrl: `http://127.0.0.1:${address.port}`,
			egressUrl: `http://127.0.0.1:${address.port}`,
			async readObject(key) {
				const graph = graphs.get(key)
				if (!graph) throw new Error('Missing S3 graph.')
				return graph
			},
		})
		stack.use(runner)
		stack.defer(() => target.stopTemporal())
		const loader = createRunnerLoader({
			async putObject(key, graph) {
				graphs.set(key, graph)
			},
			async prepare(context) {
				if (!context.userId)
					throw new Error('Compatibility Runner requires a caller owner.')
				const runId = crypto.randomUUID()
				const storageId =
					context.storageContext?.storageId ??
					(context.storageContext?.packageId
						? `package:${context.storageContext.packageId}`
						: 'execute')
				if (
					!target.env.kv.get(
						`${context.userId}:meters`,
						'outbound_fetches_per_day',
					)
				)
					target.env.kv.put({
						pk: `${context.userId}:meters`,
						sk: 'outbound_fetches_per_day',
						remaining: 10000,
					})
				if (!target.env.kv.get(`${context.userId}:meters`, 'storage_bytes'))
					target.env.kv.put({
						pk: `${context.userId}:meters`,
						sk: 'storage_bytes',
						remaining: 10000000,
					})
				return {
					runId,
					runtimeSessionId: await runnerSessionId(context.userId),
					runToken: await mintRunToken(signingKey, {
						userId: context.userId,
						runId,
						expiresAt: Date.now() + 90000,
						retriever: context.allowOutboundFetch === false,
						provenance: [
							{
								moduleId: 'entry',
								packageId: context.storageContext?.packageId ?? null,
								storageId,
							},
							...[...new Set(context.grantedSecretAuthorityPackageIds ?? [])]
								.filter(
									(packageId) =>
										packageId !== context.storageContext?.packageId,
								)
								.map((packageId) => ({
									moduleId: `package:${packageId}`,
									packageId,
									storageId: `package:${encodeURIComponent(packageId)}`,
								})),
						],
					}),
				}
			},
			register(run) {
				const unbroker = broker.register(run)
				const unegress = egress.register(run)
				return () => {
					unbroker()
					unegress()
				}
			},
			async invoke(invocation) {
				return runner.invoke(invocation.payload)
			},
		})
		const artifacts = createDynamoKv({
			region: 'us-east-1',
			tableName: 'artifacts',
			namespace: 'BUNDLE_ARTIFACTS_KV',
			send: createFakeDynamo().send,
		})
		// Fixture setup deliberately uses the admin role; owner/RLS checks have their own acceptance tests.
		const cells = {
			...target.env.STORAGE_CELLS,
			forBucket(input: { userId: string; storageId: string }) {
				if (!target.env.kv.get(`${input.userId}:meters`, 'storage_bytes'))
					target.env.kv.put({
						pk: `${input.userId}:meters`,
						sk: 'storage_bytes',
						remaining: 10000000,
					})
				return target.env.STORAGE_CELLS.forBucket(input)
			},
		}
		const records = createTestRunRecords()
		const state = createRunState({
			ledger: createDynamoInvocationLedger({
				region: 'us-east-1',
				tableName: 'invocations',
				send: createFakeDynamo().send,
			}),
			temporal: target.env.TEMPORAL,
		})
		const env = {
			...process.env,
			...target.env,
			EMAIL_BLOBS: createTestObjectBucket().bucket,
			USER_EMAIL_DOMAIN: 'inbox.kody.example.com',
			SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
			APP_BASE_URL: 'https://kody.example.com',
			...records.env,
			RUN_STATE: state,
			APP_DB_FOR_USER: (userId: string) => database.forUser(userId).db,
			STORAGE_CELLS: cells,
			...createInMemoryUserMeterEnv().env,
			APP_DB: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
			BUNDLE_ARTIFACTS_KV: artifacts,
			SECRET_KMS: target.env.kms,
			RUNNER_BUNDLER: runner,
			RUNNER_LOADER: loader,
		} as unknown as Env
		env.MAILBOX_STORE = createMailboxService({
			forUser: (userId) => database.forUser(userId).db,
			env,
		})
		const owned = stack.move()
		return {
			env,
			pg: database.pg,
			forUser: database.forUser,
			target,
			close: () => owned.disposeAsync(),
		}
	} catch (error) {
		await stack.disposeAsync()
		throw error
	}
}
