import { createTestObjectBucket } from './aws/fake-s3.ts'
import { createTestRunRecords } from './run-records.ts'
import { createDynamoInvocationLedger } from '#worker/aws/dynamo-invocation-ledger.ts'
import { createRunState } from '#worker/temporal/run-state.ts'
import { createMailboxService } from '#worker/email/mailbox-service.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createDynamoKv } from '#worker/aws/dynamo-kv.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import { createTargetTestEnv } from './aws/target-test-env.ts'
import { createTestDb } from './aws/test-db.ts'
import { createInMemoryUserMeterEnv } from './user-meter.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { createEgressHandler } from '#worker/egress/egress-proxy.ts'
import { createRunnerLoader } from '#worker/runner/loader.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import {
	runnerSessionId,
	type RunnerInvocation,
} from '#worker/runner/contract.ts'

/** Package compatibility harness: Deno, broker, PostgreSQL and SQLite. */
export async function createRunnerTestEnv(
	options: {
		restrictAdmin?: boolean
		backend?: 'deno'
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
		const graphs = new Map<string, RunnerGraph>()
		async function readObject(key: string) {
			const graph = graphs.get(key)
			if (!graph) throw new Error('Missing S3 graph.')
			return graph
		}
		const runner = await (async () => {
			const { startRunnerHost } =
				await import('../../../../tools/demo/runner-host.ts')
			const { createWorker } =
				await import('../../../../tools/demo/package-build-tools.ts')
			const brokerServer = stack.use(
				await startFrontDoorServer({ fetch: broker.fetch }),
			)
			const egressServer = stack.use(
				await startFrontDoorServer({ fetch: egress.fetch }),
			)
			const host = await startRunnerHost({
				port: 0,
				host: '127.0.0.1',
				allowLocalHttp: true,
				brokerUrl: brokerServer.origin,
				egressUrl: egressServer.origin,
				readObject,
			})
			stack.defer(host.close)
			return {
				createWorker,
				async invoke(invocation: RunnerInvocation, signal?: AbortSignal) {
					const response = await fetch(`${host.origin}/invocations`, {
						method: 'POST',
						signal,
						headers: {
							'x-amzn-bedrock-agentcore-runtime-session-id': runnerSessionId(
								invocation.bundleKey.split('/')[0]!,
								invocation.runId,
							),
						},
						body: JSON.stringify(invocation),
					})
					if (!response.ok)
						throw new Error(
							`Runner failed: ${response.status} ${await response.text()}`,
						)
					return response.json() as Promise<unknown>
				},
			}
		})()
		stack.defer(() => target.stopTemporal())
		const loader = createRunnerLoader({
			idempotency: target.env.TEMPORAL.idempotency,
			async putObject(key, graph) {
				graphs.set(key, graph)
			},
			async prepare(context, logicalRunId, timeoutMs) {
				if (!context.userId)
					throw new Error('Compatibility Runner requires a caller owner.')
				const runId = logicalRunId ?? crypto.randomUUID()
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
					runtimeSessionId: runnerSessionId(context.userId, runId),
					runToken: await mintRunToken(signingKey, {
						userId: context.userId,
						runId,
						expiresAt: Date.now() + Math.max(90000, timeoutMs ?? 90000),
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
				let unegress: () => void
				try {
					unegress = egress.register(run)
				} catch (error) {
					unbroker()
					throw error
				}
				return () => {
					unbroker()
					unegress()
				}
			},
			async invoke(invocation) {
				return runner.invoke(invocation.payload, invocation.signal)
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
