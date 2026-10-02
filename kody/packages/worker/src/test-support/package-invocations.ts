import { createDynamoInvocationLedger } from '#worker/aws/dynamo-invocation-ledger.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'
import { expect, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createPackageRuntimeInvokeTools,
	createPackageEventTools,
} from '#worker/package-invocations/service.ts'
import { createTestRunRecords } from '#worker/test-support/run-records.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

export const packageInvocationsRepoMockModule = (() => {
	const loadPackageManifestBySourceId = vi.fn()
	return {
		getSavedPackageById: vi.fn(),
		getSavedPackageByKodyId: vi.fn(),
		getSavedPackageByName: vi.fn(),
		listSavedPackagesByUserId: vi.fn(),
		loadPackageManifestBySourceId,
		// The invoke path loads the source row and manifest separately (see
		// loadInvokeManifestBySourceId); default to the same per-test data the
		// combined mock is configured with.
		loadPackageSourceRowForUser: vi.fn(
			async (input: { sourceId: string; userId: string }) =>
				(await loadPackageManifestBySourceId(input)).source,
		),
		loadPackageManifestForSource: vi.fn(
			async (input: { source: { id: string }; userId: string }) =>
				await loadPackageManifestBySourceId({
					...input,
					sourceId: input.source.id,
				}),
		),
		loadPackageSourceBySourceId: vi.fn(),
		getEntitySourceById: vi.fn(),
		loadPublishedBundleArtifactByIdentity: vi.fn(),
		persistPublishedBundleArtifact: vi.fn(),
		typecheckPackageEntrypointsFromSourceFiles: vi.fn(),
		runBundledModuleWithRegistry: vi.fn(),
		recordAgentPackageConversationUse: vi.fn(),
		dispatchRunErrorSubscriptionEvents: vi.fn(),
	}
})()

export type FakeLedgerRow = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	status: 'in_progress' | 'completed' | 'failed'
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

/** Production invocation ledger over the command-interpreting DynamoDB fake,
 * plus production run records over DynamoDB and S3 fakes. */
export function createFakeRunLog(
	options: { failClaim?: boolean; failFinish?: boolean } = {},
) {
	const dynamo = createFakeDynamo()
	const tableName = 'kody-test-idempotency'
	const ledger = createDynamoInvocationLedger({
		region: 'us-east-1',
		tableName,
		send: async (command) => {
			if (options.failClaim && command.constructor.name === 'PutItemCommand')
				throw new Error('RunLog unavailable')
			if (
				options.failFinish &&
				command.constructor.name === 'PutItemCommand' &&
				'Item' in command.input &&
				command.input.Item?.status?.S !== 'in_progress'
			)
				throw new Error('RunLog finish unavailable')
			return await dynamo.send(command)
		},
	})
	const ledgerRows = () =>
		dynamo
			.items(tableName)
			.map((item) => JSON.parse(item.record!.S!) as FakeLedgerRow)
	const save = (row: FakeLedgerRow) => {
		const previous = dynamo
			.items(tableName)
			.find((item) => JSON.parse(item.record!.S!).id === row.id)
		dynamo.putItem(tableName, {
			pk: previous?.pk ?? { S: 'user-123' },
			sk: previous?.sk ?? {
				S: `invocation#${JSON.stringify([row.tokenId, row.packageId, row.exportName, row.idempotencyKey])}`,
			},
			record: { S: JSON.stringify(row) },
			id: { S: row.id },
			status: { S: row.status },
			updatedAt: { S: row.updatedAt },
			...(row.status === 'in_progress'
				? {}
				: {
						expiresAt: {
							N: String(Math.floor(Date.now() / 1000) + 90 * 86400),
						},
					}),
		})
	}
	const runRecords = createTestRunRecords()

	return {
		state: { forUser: ledger.forUser },
		get ledgerRows() {
			return ledgerRows()
		},
		runRecords,
		/** Run items by id, attribute values unwrapped. */
		get runRows() {
			return new Map(
				runRecords.dynamo
					.items(runRecords.tableName)
					.filter((item) => item.sk?.S?.startsWith('run#'))
					.map((item) => [
						item.id!.S!,
						Object.fromEntries(
							Object.entries(item).map(([name, value]) => [
								name,
								value.S ?? (value.N === undefined ? null : Number(value.N)),
							]),
						) as Record<string, unknown>,
					]),
			)
		},
		/** Log messages by run id. */
		get runLogs() {
			return new Map(
				[...runRecords.logs.objects].map(([key, object]) => [
					key.slice(key.lastIndexOf('/') + 1, -'.json'.length),
					(
						JSON.parse(new TextDecoder().decode(object.bytes)) as Array<{
							message: string
						}>
					).map((line) => line.message),
				]),
			)
		},
		corruptStoredResponses() {
			for (const row of ledgerRows()) {
				row.responseJson = '{"status":200,"body":null}'
				save(row)
			}
		},
		seedStaleInvocation(idempotencyKey: string) {
			const completed = ledgerRows()[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const row: FakeLedgerRow = {
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				status: 'in_progress',
				responseJson: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			}
			save(row)
			return structuredClone(row)
		},
		seedFreshInvocation(idempotencyKey: string) {
			const completed = ledgerRows()[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const now = new Date().toISOString()
			save({
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				status: 'in_progress',
				responseJson: null,
				createdAt: now,
				updatedAt: now,
			})
		},
		completeInvocation(idempotencyKey: string) {
			const row = ledgerRows().find(
				(candidate) => candidate.idempotencyKey === idempotencyKey,
			)
			const completed = ledgerRows()[0]
			if (!row || !completed) throw new Error('Expected invocation rows.')
			row.status = 'completed'
			row.responseJson = completed.responseJson
			row.updatedAt = new Date().toISOString()
			save(row)
		},
	}
}

/**
 * Fake D1 that rejects EVERY `package_invocations` statement (the table is
 * dropped; the ledger lives in DynamoDB) and every write. Keyed tests
 * passing against this is the proof that no D1 ledger read or write remains
 * anywhere on the invoke path.
 */
export function createDatabase(
	options: { failClaim?: boolean; failFinish?: boolean } = {},
) {
	const runLog = createFakeRunLog(options)
	const db = {
		prepare(query: string) {
			if (query.includes('package_invocations')) {
				throw new Error(
					`Unexpected D1 access to the dropped package_invocations table: ${query}`,
				)
			}
			return {
				bind() {
					return {
						async first<T = Record<string, unknown>>() {
							return null as T | null
						},
						async all<T = Record<string, unknown>>() {
							return { results: [] as Array<T>, success: true }
						},
						async run() {
							throw new Error(
								`Unexpected D1 write on the keyed invocation path: ${query}`,
							)
						},
					}
				},
			}
		},
		runLog,
	} as unknown as D1Database & {
		runLog: ReturnType<typeof createFakeRunLog>
	}
	return db
}

export function createEnv(
	db: ReturnType<typeof createDatabase>,
	overrides: Record<string, unknown> = {},
) {
	const meter =
		overrides['USER_METERS'] == null ? createInMemoryUserMeterEnv() : null
	return {
		APP_DB: db,
		RUN_STATE: db.runLog.state,
		RUN_RECORDS: db.runLog.runRecords.records,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		...(meter ? { USER_METERS: meter.env.USER_METERS } : {}),
		...overrides,
	} as unknown as Env
}

/**
 * Env plus the in-memory UserMeter harness so tests can seed daily counters.
 */
export function createEnvWithUserMeter(
	db: ReturnType<typeof createDatabase>,
	overrides: Record<string, unknown> = {},
) {
	const meter = createInMemoryUserMeterEnv()
	return {
		env: createEnv(db, {
			USER_METERS: meter.env.USER_METERS,
			...overrides,
		}),
		meter,
	}
}

export function createToken(
	overrides: Partial<{
		packageId: string
		exportNames: Array<string>
	}> = {},
) {
	return {
		tokenId: 'discord-gateway',
		userId: 'user-123',
		email: 'me@example.com',
		packageId: overrides.packageId ?? 'pkg-1',
		exportNames: overrides.exportNames ?? ['./dispatch-message-created'],
	} as const
}

export function seedPackageResolution() {
	packageInvocationsRepoMockModule.getSavedPackageById.mockResolvedValue(null)
	packageInvocationsRepoMockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'pkg-1',
		userId: 'user-123',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	})
	packageInvocationsRepoMockModule.loadPackageManifestBySourceId.mockResolvedValue(
		{
			source: {
				id: 'source-1',
				user_id: 'user-123',
				entity_kind: 'package',
				entity_id: 'pkg-1',
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				created_at: '2026-04-27T00:00:00.000Z',
				updated_at: '2026-04-27T00:00:00.000Z',
			},
			manifest: {
				name: '@kentcdodds/discord-gateway',
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
					app: {
						entry: './src/app.ts',
					},
				},
			},
		},
	)
	packageInvocationsRepoMockModule.loadPackageSourceBySourceId.mockResolvedValue(
		{
			source: {
				id: 'source-1',
				user_id: 'user-123',
				entity_kind: 'package',
				entity_id: 'pkg-1',
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				created_at: '2026-04-27T00:00:00.000Z',
				updated_at: '2026-04-27T00:00:00.000Z',
			},
			manifest: {
				name: '@kentcdodds/discord-gateway',
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
					app: {
						entry: './src/app.ts',
					},
				},
			},
			files: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/discord-gateway',
					exports: {
						'./dispatch-message-created': './src/dispatch-message-created.ts',
					},
					kody: {
						id: 'discord-gateway',
						description: 'Discord gateway helpers',
						app: {
							entry: './src/app.ts',
						},
					},
				}),
				'src/dispatch-message-created.ts':
					'export default async function run(){ return { ok: true } }',
			},
		},
	)
	packageInvocationsRepoMockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-27T00:00:00.000Z',
		updated_at: '2026-04-27T00:00:00.000Z',
	})
	packageInvocationsRepoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-1',
				publishedCommit: 'commit-1',
			},
			artifact: {
				version: 1,
				kind: 'module',
				artifactName: './dispatch-message-created',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				entryPoint: 'src/dispatch-message-created.ts',
				mainModule: 'dist/index.js',
				modules: {
					'dist/index.js':
						'export default async function run(){ return { ok: true } }',
				},
				dependencies: [],
				packageContext: {
					packageId: 'pkg-1',
					kodyId: 'discord-gateway',
					sourceId: 'source-1',
				},
				createdAt: '2026-04-27T00:00:00.000Z',
			},
		},
	)
	packageInvocationsRepoMockModule.typecheckPackageEntrypointsFromSourceFiles.mockResolvedValue(
		{
			ok: true,
			message: 'ok',
		},
	)
	packageInvocationsRepoMockModule.persistPublishedBundleArtifact.mockResolvedValue(
		'kv:key',
	)
}

export function createSavedPackage(input: {
	id: string
	sourceId: string
	name: string
	kodyId: string
	description?: string
}) {
	return {
		id: input.id,
		userId: 'user-123',
		name: input.name,
		kodyId: input.kodyId,
		description: input.description ?? `${input.kodyId} package`,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-05-10T00:00:00.000Z',
		updatedAt: '2026-05-10T00:00:00.000Z',
	}
}

export function createSource(input: {
	id: string
	entityId: string
	commit: string
}) {
	return {
		id: input.id,
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: input.entityId,
		repo_id: `repo-${input.id}`,
		published_commit: input.commit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-05-10T00:00:00.000Z',
		updated_at: '2026-05-10T00:00:00.000Z',
	}
}

export function createManifest(input: {
	name: string
	kodyId: string
	exportName: string
	entryPoint: string
	emits?: Record<
		string,
		{ description: string; payloadSchema?: Record<string, unknown> }
	>
	subscriptions?: Record<
		string,
		{
			handler: string
			description?: string
			filters?: Record<string, unknown>
		}
	>
}) {
	return {
		name: input.name,
		exports: {
			[input.exportName]: input.entryPoint,
		},
		kody: {
			id: input.kodyId,
			description: `${input.kodyId} package`,
			emits: input.emits,
			subscriptions: input.subscriptions,
		},
	}
}

export function createModuleArtifact(input: {
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	mainModule: string
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	}
}) {
	return {
		row: {
			id: `artifact-${input.packageContext.packageId}`,
			publishedCommit: input.publishedCommit,
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: input.artifactName,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: {
				[input.mainModule]:
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: input.packageContext,
			createdAt: '2026-05-10T00:00:00.000Z',
		},
	}
}

export function seedRuntimeDispatchPackages() {
	const gateway = createSavedPackage({
		id: 'pkg-gateway',
		sourceId: 'source-gateway',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
	})
	const subscriber = createSavedPackage({
		id: 'pkg-subscriber',
		sourceId: 'source-subscriber',
		name: '@kentcdodds/discord-general-chat',
		kodyId: 'discord-general-chat',
	})
	const sources = new Map([
		[
			'source-gateway',
			createSource({
				id: 'source-gateway',
				entityId: 'pkg-gateway',
				commit: 'gateway-commit-1',
			}),
		],
		[
			'source-subscriber',
			createSource({
				id: 'source-subscriber',
				entityId: 'pkg-subscriber',
				commit: 'subscriber-commit-1',
			}),
		],
	])
	const manifests = new Map([
		[
			'source-gateway',
			createManifest({
				name: gateway.name,
				kodyId: gateway.kodyId,
				exportName: './dispatch-message-created',
				entryPoint: './src/dispatch-message-created.ts',
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
					},
				},
			}),
		],
		[
			'source-subscriber',
			createManifest({
				name: subscriber.name,
				kodyId: subscriber.kodyId,
				exportName: './handle-discord-message-created',
				entryPoint: './src/handle-discord-message-created.ts',
				subscriptions: {
					'@kentcdodds/discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'Handle Discord message events.',
					},
				},
			}),
		],
	])
	const sourceFiles = new Map([
		[
			'source-gateway',
			{
				'package.json': JSON.stringify(manifests.get('source-gateway')),
				'src/dispatch-message-created.ts':
					'export default async function dispatchMessageCreated(input: Record<string, unknown>) { return input }',
			},
		],
		[
			'source-subscriber',
			{
				'package.json': JSON.stringify(manifests.get('source-subscriber')),
				'src/handle-discord-message-created.ts': `/**
 * Handle a Discord message-created event.
 */
export default async function handleDiscordMessageCreated(input: { event: { id: string }, dryRun?: boolean }): Promise<{ handled: boolean }> {
	return { handled: true }
}`,
			},
		],
	])
	packageInvocationsRepoMockModule.getSavedPackageById.mockResolvedValue(null)
	packageInvocationsRepoMockModule.getSavedPackageByKodyId.mockImplementation(
		async (_db: unknown, input: { userId: string; kodyId: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.kodyId === gateway.kodyId) return gateway
			if (input.kodyId === subscriber.kodyId) return subscriber
			return null
		},
	)
	packageInvocationsRepoMockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { userId: string; name: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.name === gateway.name) return gateway
			if (input.name === subscriber.name) return subscriber
			return null
		},
	)
	packageInvocationsRepoMockModule.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			expect(input.userId).toBe('user-123')
			return [gateway, subscriber]
		},
	)
	packageInvocationsRepoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
		}),
	)
	packageInvocationsRepoMockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
			files: sourceFiles.get(input.sourceId) ?? {},
		}),
	)
	packageInvocationsRepoMockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) => sources.get(sourceId) ?? null,
	)
	packageInvocationsRepoMockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			sourceId: string
			artifactName: string
			entryPoint: string
		}) => {
			if (input.sourceId === 'source-gateway') {
				return createModuleArtifact({
					sourceId: 'source-gateway',
					publishedCommit: 'gateway-commit-1',
					artifactName: './dispatch-message-created',
					entryPoint: 'src/dispatch-message-created.ts',
					mainModule: 'dist/gateway.js',
					packageContext: {
						packageId: gateway.id,
						kodyId: gateway.kodyId,
						sourceId: gateway.sourceId,
					},
				})
			}
			if (input.sourceId === 'source-subscriber') {
				return createModuleArtifact({
					sourceId: 'source-subscriber',
					publishedCommit: 'subscriber-commit-1',
					artifactName:
						input.artifactName ===
						'subscription:@kentcdodds/discord.message.created'
							? 'subscription:@kentcdodds/discord.message.created'
							: './handle-discord-message-created',
					entryPoint: 'src/handle-discord-message-created.ts',
					mainModule: 'dist/subscriber.js',
					packageContext: {
						packageId: subscriber.id,
						kodyId: subscriber.kodyId,
						sourceId: subscriber.sourceId,
					},
				})
			}
			return null
		},
	)
	return { gateway, manifests, sourceFiles, sources, subscriber }
}

export function createRuntimeDispatchTools(db: D1Database) {
	return createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRunRecord: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: 0,
	})
}

export function createRuntimeEventTools(
	db: D1Database,
	options: {
		envOverrides?: Record<string, unknown>
		packageInvokeDepth?: number
	} = {},
) {
	return createPackageEventTools({
		env: {
			...(createEnv(db) as unknown as Record<string, unknown>),
			...options.envOverrides,
		} as unknown as Env,
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRunRecord: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: options.packageInvokeDepth ?? 0,
	})
}
