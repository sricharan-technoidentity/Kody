import { createEphemeralGitWorkspace } from '#worker/repo/ephemeral-git-workspace.ts'
import { type CodeInterpreterSession } from '#worker/repo/code-interpreter-workspace.ts'
import { createRepoSessionServices } from '#worker/repo/repo-session-service.ts'
import { createRepoSessionActivities } from '#worker/temporal/activities/repo-session.ts'
import { getRepoSessionById } from '#worker/repo/repo-sessions.ts'

/** The same interpreter session survives activity/service recreation; each owner has separate files and state. */
export function createRepoCodeInterpreterFake() {
	const sessions = new Map<string, CodeInterpreterSession>()
	const results = new Map<string, { ok: boolean; output: string }>()
	const calls: Array<{ userId: string; sessionId: string; check: string }> = []
	return {
		sessions,
		calls,
		respondWith(
			check: 'bundle' | 'typecheck' | 'lint',
			result: { ok: boolean; output: string },
		) {
			results.set(check, result)
		},
		session(userId: string, sessionId: string) {
			if (!userId || !sessionId)
				throw new Error('Interpreter owner and session are required.')
			const key = JSON.stringify([userId, sessionId])
			const existing = sessions.get(key)
			if (existing) return existing
			const { filesystem } = createEphemeralGitWorkspace()
			const state = new Map<string, unknown>()
			const session: CodeInterpreterSession = {
				filesystem,
				storage: {
					async get<T>(key: string) {
						return state.get(key) as T | undefined
					},
					async put(key, value) {
						state.set(key, structuredClone(value))
					},
					async deleteAll() {
						state.clear()
					},
				},
				async run(check) {
					calls.push({ userId, sessionId, check })
					const result = results.get(check)
					if (!result) throw new Error(`No scripted ${check} result.`)
					return result
				},
			}
			sessions.set(key, session)
			return session
		},
	}
}

export function createRepoServicesFake(
	envForOwner: (ownerId: string) => Promise<Env> | Env,
) {
	const interpreter = createRepoCodeInterpreterFake()
	const service = createRepoSessionServices({
		forUser: envForOwner,
		session: interpreter.session,
	})
	return {
		interpreter,
		service,
		activities: createRepoSessionActivities({
			service,
			async row(userId, sessionId) {
				return getRepoSessionById(await envForOwner(userId), {
					userId,
					sessionId,
				})
			},
		}),
	}
}
