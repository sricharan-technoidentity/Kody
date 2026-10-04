export const sqlRetryMaxAttempts = 6
export const sqlRetryBaseDelayMs = 150
export const sqlConnectionLostMessage = 'Connection terminated unexpectedly'
export const sqlSerializationFailureMessage =
	'could not serialize access due to concurrent update'

const retryableCodes = new Set([
	'40001',
	'40P01',
	'55P03',
	'08000',
	'08003',
	'08006',
	'57P01',
	'57P02',
	'57P03',
	'53300',
])
const retryableMessages = new Set([
	sqlConnectionLostMessage,
	sqlSerializationFailureMessage,
	'deadlock detected',
	'terminating connection due to administrator command',
])

/** Message fallback for wrappers and telemetry that omit SQLSTATE. */
export function isRetryableSqlMessage(message: string) {
	return retryableMessages.has(
		message
			.trim()
			.replace(/^Error:\s*/i, '')
			.replace(/\.$/, ''),
	)
}
export function isRetryableSqlError(error: unknown): boolean {
	const seen = new Set<unknown>()
	while (error && !seen.has(error)) {
		seen.add(error)
		if (typeof error === 'string') return isRetryableSqlMessage(error)
		if (typeof error !== 'object') return false
		const candidate = error as {
			code?: unknown
			message?: unknown
			cause?: unknown
		}
		// SQLSTATE wins over message matching; constraints must fail immediately.
		if (typeof candidate.code === 'string')
			return retryableCodes.has(candidate.code)
		if (
			typeof candidate.message === 'string' &&
			isRetryableSqlMessage(candidate.message)
		)
			return true
		error = candidate.cause
	}
	return false
}

export class SqlAttemptTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`SQL attempt timed out after ${timeoutMs}ms`)
		this.name = 'SqlAttemptTimeoutError'
	}
}
function withAttemptTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const handle = setTimeout(
			() => reject(new SqlAttemptTimeoutError(timeoutMs)),
			timeoutMs,
		)
		operation.then(
			(value) => {
				clearTimeout(handle)
				resolve(value)
			},
			(error) => {
				clearTimeout(handle)
				reject(error)
			},
		)
	})
}
/**
 * Retry idempotent SQL operations after transaction/connection failures.
 * Attempt deadlines are opt-in for read probes; timing out does not cancel SQL.
 */
export async function runSqlWithRetry<T>(
	operation: () => Promise<T>,
	options: {
		maxAttempts?: number
		baseDelayMs?: number
		attemptTimeoutMs?: number
	} = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? sqlRetryMaxAttempts
	const baseDelayMs = options.baseDelayMs ?? sqlRetryBaseDelayMs
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const pending = operation()
			return options.attemptTimeoutMs === undefined
				? await pending
				: await withAttemptTimeout(pending, options.attemptTimeoutMs)
		} catch (error) {
			lastError = error
			if (
				(!isRetryableSqlError(error) &&
					!(
						options.attemptTimeoutMs !== undefined &&
						error instanceof SqlAttemptTimeoutError
					)) ||
				attempt === maxAttempts
			)
				throw error
			await new Promise((resolve) =>
				setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
			)
		}
	}
	throw lastError
}
