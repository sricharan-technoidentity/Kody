// Telemetry compatibility for historical platform events and workerd sandboxes.
// This classifier never controls PostgreSQL retries.
/**
 * Cloudflare D1 emits this while a REST/API export is in progress. Exports
 * block other database requests for consistency (see D1 import/export docs),
 * so production MCP/cron traffic fails for the duration of the nightly DR
 * backup export. Same class of transient unavailability as SQLITE_BUSY.
 */
const d1LongRunningExportMessage = 'Currently processing a long-running export'

/**
 * Cloudflare D1 binding transport blip (`D1_ERROR: Network connection lost.`).
 * Not an application defect — the Worker lost its session to D1 mid-query.
 * Same retry / Sentry-drop class as SQLITE_BUSY and long-running exports.
 * Match only the exact D1 forms (optional `Error:` / `D1_ERROR:` prefixes) so
 * unrelated "Network connection lost while …" messages stay out.
 */
const d1NetworkConnectionLostMessage = 'Network connection lost'

/**
 * Cloudflare D1 capacity blips. Two exact platform phrasings exist:
 * - `D1_ERROR: D1 DB is overloaded. Requests queued for too long.`
 * - `D1_ERROR: D1 DB is overloaded. Too many requests queued.`
 * Not an application defect — D1's request queue timed out or rejected under
 * platform load. Same retry / Sentry-drop class as SQLITE_BUSY and binding
 * transport blips. Match only these exact D1 forms (optional `Error:` /
 * `D1_ERROR:` prefixes) so unrelated "… overloaded …" messages stay out.
 */
const d1DbOverloadedMessage =
	'D1 DB is overloaded. Requests queued for too long'

const d1DbOverloadedTooManyQueuedMessage =
	'D1 DB is overloaded. Too many requests queued'

/**
 * Cloudflare D1 opaque platform failures with a support reference, e.g.
 * `D1_ERROR: internal error; reference = <id>`,
 * `D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = <id>`,
 * and `D1_ERROR: Internal error in Durable Object storage caused object to be
 * reset; reference = <id>` (KODY-82 — D1 is DO-backed; the binding can surface
 * either storage phrasing). Not an application defect — D1's storage/backend
 * hit an internal fault. Same retry / Sentry-drop class as SQLITE_BUSY and
 * binding transport blips. Require the `reference =` token and only these
 * known phrasings so bare "internal error" (or unrelated "internal error
 * while …") from app code stays non-retryable and Sentry-visible. Cloudflare
 * reference ids are alphanumeric and may include `_` or `-`.
 */
const d1InternalErrorReferencePattern =
	/^internal error(?: in (?:D1 DB|Durable Object) storage caused object to be reset)?;\s*reference\s*=\s*[A-Za-z0-9_-]+$/i

function stripD1ErrorPrefixes(message: string) {
	return message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
}

function isExactD1PlatformMessage(message: string, expected: string) {
	const normalized = stripD1ErrorPrefixes(message)
	return normalized === expected || normalized === `${expected}.`
}

function isD1NetworkConnectionLostMessage(message: string) {
	return isExactD1PlatformMessage(message, d1NetworkConnectionLostMessage)
}

function isD1DbOverloadedMessage(message: string) {
	return (
		isExactD1PlatformMessage(message, d1DbOverloadedMessage) ||
		isExactD1PlatformMessage(message, d1DbOverloadedTooManyQueuedMessage)
	)
}

function isD1InternalErrorMessage(message: string) {
	return d1InternalErrorReferencePattern.test(stripD1ErrorPrefixes(message))
}

export function isHistoricalPlatformTransientMessage(message: string) {
	return (
		message.includes('SQLITE_BUSY') ||
		message.includes('database is locked') ||
		message.includes(d1LongRunningExportMessage) ||
		isD1NetworkConnectionLostMessage(message) ||
		isD1DbOverloadedMessage(message) ||
		isD1InternalErrorMessage(message)
	)
}
