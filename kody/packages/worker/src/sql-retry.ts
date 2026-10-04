import { type ErrorEvent } from '@sentry/core'
import { isRetryableSqlMessage } from '@kody-internal/shared/sql-retry.ts'
export * from '@kody-internal/shared/sql-retry.ts'
export function isRetryableSqlSentryEvent(event: ErrorEvent) {
	const messages = [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
	return messages.some(
		(message) => typeof message === 'string' && isRetryableSqlMessage(message),
	)
}
