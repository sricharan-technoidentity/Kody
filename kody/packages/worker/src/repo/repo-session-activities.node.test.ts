import { expect, test, vi } from 'vitest'
import { createAppActivities } from '#worker/temporal/activities/app.ts'
import { createRepoSessionServices } from './repo-session-service.ts'
import { createRepoCodeInterpreterFake } from '#worker/test-support/repo-code-interpreter.ts'
import { Workspace } from './code-interpreter-workspace.ts'
import { type RepoSessionRow } from './types.ts'
import { type RepoSessionRpc } from './repo-session-rpc.ts'

test('app activities bind repo owners, reject unknown operations and close expired sessions', async () => {
	const interpreter = createRepoCodeInterpreterFake()
	const forUser = vi.fn(
		(ownerId: string) =>
			({
				REPO_SESSION_BLOBS: {
					list: async () => ({ objects: [], truncated: false }),
				},
				APP_DB: { ownerId },
			}) as unknown as Env,
	)
	const services = createRepoSessionServices({
		forUser,
		session: interpreter.session,
	})
	const alice = await services('alice', 'same-id')
	await expect(
		alice.purgeSession({ userId: 'bob', sessionId: 'same-id' }),
	).rejects.toThrow('owner or session mismatch')
	await expect(
		alice.purgeSession({ userId: 'alice', sessionId: 'other-id' }),
	).rejects.toThrow('owner or session mismatch')
	expect(
		(alice as unknown as { constructor?: unknown }).constructor,
	).toBeUndefined()
	const workspace = new Workspace(interpreter.session('alice', 'same-id'))
	await workspace.mkdir('/session', { recursive: true })
	await workspace.writeFile('/session/file.txt', 'persisted')
	expect(
		(await (await services('alice', 'same-id')).getEstimatedBytes())
			.estimatedBytes,
	).toBe(9)
	expect(
		(await (await services('bob', 'same-id')).getEstimatedBytes())
			.estimatedBytes,
	).toBe(0)
	expect(forUser.mock.calls.map(([owner]) => owner)).toEqual([
		'alice',
		'alice',
		'bob',
	])
	const readFile = vi.fn(async () => ({
		path: 'file.txt',
		content: 'persisted',
	}))
	const cleanupSessionBranch = vi.fn(async () => undefined)
	const backend = vi.fn(
		(_owner: string, _id: string) =>
			({ readFile, cleanupSessionBranch }) as unknown as RepoSessionRpc,
	)
	const row = {
		status: 'published',
		expires_at: '2000-01-01T00:00:00.000Z',
	} as RepoSessionRow
	const catalog = vi.fn((_owner: string) => ({
		getSessionById: vi.fn(async () => row),
	}))
	const activities = createAppActivities({
		REPO_SESSION_SERVICES: backend,
		REPO_SESSION_CATALOG: catalog,
	} as unknown as Env)
	await expect(
		activities.operateRepoSession({
			userId: 'alice',
			sessionId: 'same-id',
			method: 'readFile',
			payload: { userId: 'bob', sessionId: 'same-id' },
		}),
	).rejects.toThrow('owner or session mismatch')
	await expect(
		activities.operateRepoSession({
			userId: 'alice',
			sessionId: 'same-id',
			method: 'constructor' as keyof RepoSessionRpc,
			payload: { userId: 'alice', sessionId: 'same-id' },
		}),
	).rejects.toThrow('Unknown repo session operation')
	expect(backend).not.toHaveBeenCalled()
	expect(
		await activities.operateRepoSession({
			userId: 'alice',
			sessionId: 'same-id',
			method: 'readFile',
			payload: { userId: 'alice', sessionId: 'same-id', path: 'file.txt' },
		}),
	).toMatchObject({
		result: { content: 'persisted' },
		dueAt: Date.parse(row.expires_at!),
	})
	await activities.closeRepoSession({ userId: 'alice', sessionId: 'same-id' })
	expect(cleanupSessionBranch).toHaveBeenCalledWith({
		userId: 'alice',
		sessionId: 'same-id',
		reason: 'expired',
	})
	expect(backend.mock.calls).toEqual([
		['alice', 'same-id'],
		['alice', 'same-id'],
	])
	expect(catalog.mock.calls).toEqual([['alice'], ['alice']])
})
