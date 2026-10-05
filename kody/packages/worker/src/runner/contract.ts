import { createHash } from 'node:crypto'
import { type createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { type SerializedWorkerLoaderModule } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export type RunnerGraph = {
	mainModule: string
	modules: WorkerLoaderModules | Record<string, SerializedWorkerLoaderModule>
	compatibilityDate: string
	compatibilityFlags: Array<string>
	invocation?: unknown
	env?: Record<string, unknown>
	runtimeMethods?: Record<string, Array<string>>
	providers?: Array<string>
	method?: 'evaluate' | 'fetch'
	entrypointName?: string
	surface?: string
	timeoutMs?: number
	bodyLimitBytes?: number
	responseLimitBytes?: number
}

export async function awaitRunnerTask<T>(
	task: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return task
	if (signal.aborted) return Promise.race([task, Promise.reject(signal.reason)])
	let cancel: () => void = () => {}
	try {
		return await Promise.race([
			task,
			new Promise<never>((_resolve, reject) => {
				cancel = () => reject(signal.reason)
				signal.addEventListener('abort', cancel, { once: true })
			}),
		])
	} finally {
		signal.removeEventListener('abort', cancel)
	}
}

export type RunnerDispatchStore = Pick<
	ReturnType<typeof createDynamoIdempotency>,
	'claimIdempotencyKey'
>

export type RunnerInvocation = {
	bundleKey: string
	runToken: string
	runId: string
}

export function runnerInputKey(userId: string, runId: string) {
	for (const value of [userId, runId]) {
		if (
			!value ||
			value === '.' ||
			value === '..' ||
			/[/\\]/.test(value) ||
			[...value].some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			)
		)
			throw new Error('Invalid Runner owner or run identity.')
	}
	return `${userId}/runner-inputs/${runId}.json`
}

export function runnerSessionId(userId: string, runId: string) {
	runnerInputKey(userId, runId)
	return createHash('sha256')
		.update(JSON.stringify([userId, runId]))
		.digest('hex')
}

/** The transport contains references only; execution metadata belongs in the graph. */
export function parseRunnerInvocation(value: unknown): RunnerInvocation {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Runner requires an exact graph reference payload.')
	const payload = value as Record<string, unknown>
	if (
		Object.keys(payload).length !== 3 ||
		!['bundleKey', 'runToken', 'runId'].every(
			(key) =>
				Object.hasOwn(payload, key) &&
				typeof payload[key] === 'string' &&
				payload[key].length > 0,
		)
	)
		throw new Error('Runner requires an exact graph reference payload.')
	return payload as RunnerInvocation
}

/** Once dispatch begins, a lost response may conceal completed external effects. */
export class RunnerInvocationError extends Error {
	readonly dispatched: boolean

	constructor(dispatched: boolean, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause })
		this.name = 'RunnerInvocationError'
		this.dispatched = dispatched
	}
}

/** A durable fence survives activity/host crashes; never release an uncertain dispatch. */
export async function claimRunnerDispatch(
	store: RunnerDispatchStore,
	userId: string,
	runId: string,
) {
	try {
		const claim = await store.claimIdempotencyKey({
			userId,
			surface: 'runner-dispatch',
			key: runId,
			runId,
		})
		if (!claim.claimed)
			throw new Error(
				'Previous Runner dispatch may have completed; automatic replay is denied.',
			)
	} catch (error) {
		// Even a lost claim response is ambiguous: the write may have committed.
		throw new RunnerInvocationError(true, error)
	}
}
