import { expect, test } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { createRepoCodeInterpreterFake } from '#worker/test-support/repo-code-interpreter.ts'
import { createGit } from './code-interpreter-git.ts'
import {
	Workspace,
	createWorkspaceStateBackend,
} from './code-interpreter-workspace.ts'
import { planRepoSessionContentEdits } from './plan-repo-session-content-edits.ts'
import { createRepoSessionClient } from './repo-session-client.ts'
import { type RepoSessionActivities } from '#worker/temporal/activities/repo-session.ts'

// Uses real git and interpreter file/state APIs; service publish policies retain their existing behavior suite.
test('RepoSession serializes Updates across Continue-As-New, rejects foreign owners and closes on idle', async () => {
	const temporal = await createTemporalEnv({ timeSkipping: true })
	try {
		const interpreter = createRepoCodeInterpreterFake()
		const session = interpreter.session('alice', 'session')
		const workspace = new Workspace(session)
		const state = createWorkspaceStateBackend(workspace)
		const git = createGit(session.filesystem, '/session')
		await workspace.mkdir('/session', { recursive: true })
		await git.init({ dir: '/session', defaultBranch: 'main' })
		let closed = 0
		const activities: RepoSessionActivities = {
			async operateRepoSession(input) {
				if (input.userId !== 'alice') throw new Error('foreign owner')
				let result: unknown
				if (input.method === 'applyEdits') {
					const edits = input.payload.edits as Array<{
						kind: 'write'
						path: string
						content: string
					}>
					const plan = await planRepoSessionContentEdits(
						edits.map((edit) => ({ ...edit, path: `/session/${edit.path}` })),
						(path) => workspace.readFile(path),
					)
					result = await state.applyEditPlan(plan)
				} else if (input.method === 'readFile')
					result = {
						path: input.payload.path,
						content: await workspace.readFile(`/session/${input.payload.path}`),
					}
				else if (input.method === 'sessionCommit') {
					await git.add({ dir: '/session', filepath: '.' })
					result = await git.commit({
						dir: '/session',
						message: String(input.payload.message),
						author: { name: 'Test', email: 'test@invalid.local' },
					})
				} else throw new Error('unexpected operation')
				return { result, dueAt: Date.now() + 60_000 }
			},
			async closeRepoSession(input) {
				expect(input).toMatchObject({ userId: 'alice', sessionId: 'session' })
				await workspace.rm('/session', { recursive: true })
				closed += 1
			},
		}
		await temporal.startWorker({
			taskQueue: 'platform',
			activities: activities as never,
		})
		const handle = await temporal.client.workflow.start('RepoSession', {
			workflowId: 'alice:repo:session',
			taskQueue: 'platform',
			args: [{ userId: 'alice', sessionId: 'session', stepsPerRun: 2 }],
		})
		const firstRunId = (await handle.describe()).runId
		const client = createRepoSessionClient(
			temporal.temporal,
			'alice',
			'session',
		)
		await expect(
			client.readFile({
				userId: 'bob',
				sessionId: 'session',
				path: 'index.ts',
			}),
		).rejects.toThrow('owner or session mismatch')
		await expect(
			handle.executeUpdate('edit', {
				args: [
					{
						userId: 'bob',
						sessionId: 'session',
						method: 'applyEdits',
						payload: { userId: 'bob', sessionId: 'session', edits: [] },
					},
				],
			}),
		).rejects.toThrow('Workflow Update failed')
		await client.applyEdits({
			userId: 'alice',
			sessionId: 'session',
			edits: [
				{
					kind: 'write',
					path: 'index.ts',
					content: 'export const value = 1\n',
				},
			],
		})
		const commit = await client.sessionCommit({
			userId: 'alice',
			sessionId: 'session',
			message: 'First',
		})
		expect(commit.oid).toMatch(/^[a-f0-9]{40}$/)
		expect(
			await client.readFile({
				userId: 'alice',
				sessionId: 'session',
				path: 'index.ts',
			}),
		).toMatchObject({ content: 'export const value = 1\n' })
		const history = await temporal.client.workflow
			.getHandle('alice:repo:session', firstRunId)
			.fetchHistory()
		expect(
			history.events?.some(
				(event) => event.workflowExecutionContinuedAsNewEventAttributes,
			),
		).toBe(true)
		expect(
			await new Workspace(interpreter.session('bob', 'session')).readFile(
				'/session/index.ts',
			),
		).toBeNull()
		await handle.result()
		expect(closed).toBe(1)
		expect(await workspace.readFile('/session/index.ts')).toBeNull()
	} finally {
		await temporal.close()
	}
}, 60_000)

test('RepoSession replans its idle timer when an Update shortens the deadline', async () => {
	const temporal = await createTemporalEnv({ timeSkipping: true })
	try {
		let closed = false
		await temporal.startWorker({
			taskQueue: 'platform',
			activities: {
				operateRepoSession: async () => ({
					result: null,
					dueAt: Date.now() + 60_000,
				}),
				closeRepoSession: async () => {
					closed = true
				},
			},
		})
		const handle = await temporal.client.workflow.start('RepoSession', {
			workflowId: 'alice:repo:idle',
			taskQueue: 'platform',
			args: [
				{ userId: 'alice', sessionId: 'idle', dueAt: Date.now() + 3_600_000 },
			],
		})
		await handle.executeUpdate('operation', {
			args: [
				{
					userId: 'alice',
					sessionId: 'idle',
					method: 'getEstimatedBytes',
					payload: {},
				},
			],
		})
		await handle.result()
		const events = (await handle.fetchHistory()).events!
		const elapsed =
			Number(events.at(-1)!.eventTime!.seconds) -
			Number(events[0]!.eventTime!.seconds)
		expect(elapsed).toBeLessThan(120)
		expect(closed).toBe(true)
	} finally {
		await temporal.close()
	}
}, 60_000)
