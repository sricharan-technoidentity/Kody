import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	buildPackageAppWorker: vi.fn(),
	createMcpCallerContext: vi.fn(),
	buildFacetName: vi.fn((value?: string | null) => value?.trim() || 'main'),
	getSavedPackageById: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#mcp/context.ts', () => ({
	createMcpCallerContext: (...args: Array<unknown>) =>
		mockModule.createMcpCallerContext(...args),
}))

vi.mock('#mcp/app-runner-facet-names.ts', () => ({
	buildFacetName: (...args: Array<unknown>) =>
		mockModule.buildFacetName(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./package-app.ts', () => ({
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

const { resolvePackageAppWorkerCacheKey } =
	await import('./realtime-session.ts')

const binding = {
	userId: 'user-1',
	packageId: 'package-1',
	kodyId: 'example',
	sourceId: 'source-1',
	baseUrl: 'https://example.com',
}

test('resolvePackageAppWorkerCacheKey encodes binding identity and published commit state', async () => {
	const env = {
		APP_DB: {} as SqlDatabase,
	} as Env

	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-2',
		indexed_commit: 'commit-2',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const publishedCommitCacheKey = await resolvePackageAppWorkerCacheKey({
		env,
		binding,
	})

	expect(publishedCommitCacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			'commit-2',
		]),
	)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledWith({}, 'source-1')

	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const unpublishedCacheKey = await resolvePackageAppWorkerCacheKey({
		env,
		binding,
	})

	expect(unpublishedCacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			null,
		]),
	)
})

import { createDynamoRealtimeSessions } from '#worker/aws/dynamo-realtime-sessions.ts'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { AccountSuspendedError } from '#worker/account/account-suspension.ts'
import { packageRealtimeSessionRpc } from './realtime-session.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: vi.fn(async () => ({})),
}))

test('realtime state supports list filters, owner isolation, disconnect and deferred transport without claiming delivery', async () => {
	vi.mocked(resolveBackgroundMcpUser).mockResolvedValue({} as never)
	const dynamo = createFakeDynamo()
	const store = createDynamoRealtimeSessions({
		region: 'us-east-1',
		tableName: 'sessions',
		send: dynamo.send,
	})
	const env = { APP_DB: {}, REALTIME_SESSIONS: store } as unknown as Env
	const rpc = packageRealtimeSessionRpc({ ...binding, env })
	await expect(rpc.listSessions()).resolves.toEqual({ sessions: [] })
	await expect(rpc.emit('missing', {})).resolves.toEqual({
		delivered: false,
		reason: 'session_not_connected',
	})
	const session = {
		id: 'session',
		facet: 'main',
		topics: ['updates'],
		connectedAt: '2026-10-02',
		lastSeenAt: '2026-10-02',
	}
	await store.put(binding, session)
	await expect(rpc.listSessions({ topic: 'updates' })).resolves.toMatchObject({
		sessions: [{ session_id: 'session', topics: ['updates'] }],
	})
	await expect(rpc.listSessions({ facet: 'other' })).resolves.toEqual({
		sessions: [],
	})
	await expect(
		packageRealtimeSessionRpc({
			...binding,
			userId: 'other',
			env,
		}).listSessions(),
	).resolves.toEqual({ sessions: [] })
	await expect(rpc.emit('session', {})).resolves.toEqual({
		delivered: false,
		reason: 'realtime_transport_deferred',
	})
	await expect(rpc.broadcast({ data: {} })).resolves.toEqual({
		deliveredCount: 0,
		sessionIds: [],
	})
	expect((await rpc.connect(new Request('https://example.com'))).status).toBe(
		501,
	)
	await rpc.disconnect('session')
	await expect(rpc.listSessions()).resolves.toEqual({ sessions: [] })
	await store.put(binding, session)
	await rpc.purge()
	await expect(rpc.listSessions()).resolves.toEqual({ sessions: [] })
})

test('suspended realtime owner cannot deliver or connect and stale sessions are removed without package hooks', async () => {
	const store = createDynamoRealtimeSessions({
		region: 'us-east-1',
		tableName: 'sessions',
		send: createFakeDynamo().send,
	})
	const env = { APP_DB: {}, REALTIME_SESSIONS: store } as unknown as Env
	await store.put(binding, {
		id: 'session',
		facet: 'main',
		topics: [],
		connectedAt: '2026-10-02',
		lastSeenAt: '2026-10-02',
	})
	vi.mocked(resolveBackgroundMcpUser).mockRejectedValue(
		new AccountSuspendedError(),
	)
	const rpc = packageRealtimeSessionRpc({ ...binding, env })
	await expect(rpc.emit('session', {})).resolves.toEqual({
		delivered: false,
		reason: 'account_suspended',
	})
	await expect(rpc.broadcast({ data: {} })).resolves.toEqual({
		deliveredCount: 0,
		sessionIds: [],
	})
	const response = await rpc.connect(new Request('https://example.com'))
	expect(response.status).toBe(403)
	await expect(response.json()).resolves.toMatchObject({
		error: { code: 'account_suspended' },
	})
	expect(await store.list(binding)).toEqual([])
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
	vi.mocked(resolveBackgroundMcpUser).mockResolvedValue({} as never)
})
