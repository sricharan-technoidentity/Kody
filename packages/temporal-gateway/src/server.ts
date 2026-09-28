import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadClientConnectConfig } from '@temporalio/envconfig'
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client'
import {
	parseTemporalGatewayCancelRequest,
	parseTemporalGatewayReconciliationRequest,
	parseTemporalGatewaySignalWithStartRequest,
	parseTemporalGatewayStartRequest,
} from '@kody-internal/shared/temporal/schemas.ts'
import {
	parseTemporalScheduleDeleteRequest,
	parseTemporalScheduleDescribeRequest,
	parseTemporalScheduleUpsertRequest,
} from '@kody-internal/shared/temporal/schedule-schemas.ts'
import {
	parseTemporalSigningKeys,
	verifyTemporalSignature,
} from '@kody-internal/shared/temporal/signing.ts'
import {
	cancelTemporalWorkflow,
	describeTemporalWorkflow,
	listTemporalWorkflowsForReconciliation,
	signalWithStartTemporalWorkflow,
	startTemporalWorkflow,
} from './workflows.ts'
import {
	deleteTemporalSchedule,
	describeTemporalSchedule,
	upsertTemporalSchedule,
} from './schedules.ts'

const maxBodyBytes = 64 * 1024
const requestWindowMs = 5 * 60_000

export type TemporalGatewayRequestEvent = {
	route: string
	method: string
	status: number
	authOutcome:
		| 'not_required'
		| 'not_checked'
		| 'verified'
		| 'rate_limited'
		| 'missing_header'
		| 'unknown_key'
		| 'expired'
		| 'invalid_digest'
		| 'invalid_signature'
		| 'replayed'
	durationMs: number
}

function normalizedRoute(method: string, pathname: string) {
	if (method === 'GET' && pathname === '/health') return '/health'
	if (method === 'GET' && pathname.startsWith('/v1/workflows/')) {
		return '/v1/workflows/:workflowId'
	}
	if (
		[
			'/v1/workflows/start',
			'/v1/workflows/signal-with-start',
			'/v1/workflows/cancel',
			'/v1/workflows/reconciliation-sample',
			'/v1/schedules/upsert',
			'/v1/schedules/delete',
			'/v1/schedules/describe',
		].includes(pathname)
	) {
		return pathname
	}
	return 'unknown'
}

function logTemporalGatewayRequest(event: TemporalGatewayRequestEvent) {
	console.info('temporal_gateway_request', event)
}

class MemoryNonceStore {
	readonly #nonces = new Map<string, number>()

	async consume(input: { keyId: string; nonce: string; expiresAtMs: number }) {
		const now = Date.now()
		for (const [key, expiry] of this.#nonces) {
			if (expiry < now) this.#nonces.delete(key)
		}
		const key = `${input.keyId}:${input.nonce}`
		if (this.#nonces.has(key)) return false
		this.#nonces.set(key, input.expiresAtMs)
		return true
	}
}

class KeyRateLimiter {
	readonly #requests = new Map<string, Array<number>>()

	allow(keyId: string, now = Date.now()) {
		const cutoff = now - 60_000
		const recent = (this.#requests.get(keyId) ?? []).filter(
			(timestamp) => timestamp > cutoff,
		)
		const limit = Number(
			process.env['TEMPORAL_GATEWAY_REQUESTS_PER_MINUTE'] ?? 300,
		)
		if (recent.length >= limit) return false
		recent.push(now)
		this.#requests.set(keyId, recent)
		return true
	}
}

function requiredEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`Missing ${name}.`)
	return value
}

async function readBody(request: IncomingMessage) {
	const chunks: Array<Buffer> = []
	let bytes = 0
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		bytes += buffer.byteLength
		if (bytes > maxBodyBytes) throw new Error('request_too_large')
		chunks.push(buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function respond(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	})
	response.end(JSON.stringify(body))
}

function requestHeaders(request: IncomingMessage) {
	const headers = new Headers()
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item)
		} else if (value !== undefined) {
			headers.set(name, value)
		}
	}
	return headers
}

export function createTemporalGatewayServer(input: {
	client: Client
	keys: ReturnType<typeof parseTemporalSigningKeys>
	recordRequest?: (event: TemporalGatewayRequestEvent) => void
	now?: () => number
}) {
	const nonces = new MemoryNonceStore()
	const rateLimiter = new KeyRateLimiter()
	const recordRequest = input.recordRequest ?? logTemporalGatewayRequest
	return createServer(async (request, response) => {
		const now = input.now ?? Date.now
		const startedAt = now()
		const method = request.method ?? 'UNKNOWN'
		const pathname = new URL(request.url ?? '/', 'http://temporal-gateway')
			.pathname
		let authOutcome: TemporalGatewayRequestEvent['authOutcome'] =
			pathname === '/health' ? 'not_required' : 'not_checked'
		response.once('finish', () => {
			recordRequest({
				route: normalizedRoute(method, pathname),
				method,
				status: response.statusCode,
				authOutcome,
				durationMs: Math.max(0, now() - startedAt),
			})
		})
		try {
			const url = new URL(request.url ?? '/', 'http://temporal-gateway')
			if (request.method === 'GET' && url.pathname === '/health') {
				return respond(response, 200, { ok: true })
			}
			if (request.method !== 'POST' && request.method !== 'GET') {
				return respond(response, 404, { error: 'not_found' })
			}
			const body = await readBody(request)
			const verification = await verifyTemporalSignature({
				keys: input.keys,
				headers: requestHeaders(request),
				method: request.method,
				pathname: url.pathname,
				body,
				maxClockSkewMs: requestWindowMs,
				consumeNonce: (nonce) => nonces.consume(nonce),
			})
			if (!verification.ok) {
				authOutcome = verification.code
				return respond(response, 401, { error: verification.code })
			}
			if (!rateLimiter.allow(verification.keyId)) {
				authOutcome = 'rate_limited'
				return respond(
					response,
					429,
					{ error: 'rate_limited' },
					{ 'retry-after': '60' },
				)
			}
			authOutcome = 'verified'
			if (
				request.method === 'GET' &&
				url.pathname.startsWith('/v1/workflows/')
			) {
				const workflowId = decodeURIComponent(
					url.pathname.slice('/v1/workflows/'.length),
				)
				return respond(
					response,
					200,
					await describeTemporalWorkflow(input.client, workflowId),
				)
			}
			if (request.method !== 'POST') {
				return respond(response, 404, { error: 'not_found' })
			}
			const parsed = JSON.parse(body) as unknown
			if (url.pathname === '/v1/workflows/start') {
				const start = parseTemporalGatewayStartRequest(parsed)
				if (verification.idempotencyKey !== `start:${start.workflowId}`) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					202,
					await startTemporalWorkflow(input.client, start),
				)
			}
			if (url.pathname === '/v1/workflows/signal-with-start') {
				const operation = parseTemporalGatewaySignalWithStartRequest(parsed)
				if (
					verification.idempotencyKey !==
					`signal-with-start:${operation.workflowId}:${operation.signalName}:${operation.signalArgs[0]}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					202,
					await signalWithStartTemporalWorkflow(input.client, operation),
				)
			}
			if (url.pathname === '/v1/workflows/cancel') {
				const cancel = parseTemporalGatewayCancelRequest(parsed)
				if (
					verification.idempotencyKey !==
					`cancel:${cancel.workflowId}:${cancel.reason}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					202,
					await cancelTemporalWorkflow(input.client, cancel.workflowId),
				)
			}
			if (url.pathname === '/v1/workflows/reconciliation-sample') {
				const sample = parseTemporalGatewayReconciliationRequest(parsed)
				if (
					verification.idempotencyKey !==
					`reconciliation-sample:${sample.workflowType}:${String(sample.limit)}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					200,
					await listTemporalWorkflowsForReconciliation(input.client, sample),
				)
			}
			if (url.pathname === '/v1/schedules/upsert') {
				const upsert = parseTemporalScheduleUpsertRequest(parsed)
				if (
					verification.idempotencyKey !==
					`schedule:${upsert.scheduleId}:upsert:${String(upsert.desiredVersion)}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					200,
					await upsertTemporalSchedule(input.client, upsert),
				)
			}
			if (url.pathname === '/v1/schedules/delete') {
				const deletion = parseTemporalScheduleDeleteRequest(parsed)
				if (
					verification.idempotencyKey !==
					`schedule:${deletion.scheduleId}:delete:${String(deletion.desiredVersion)}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					200,
					await deleteTemporalSchedule(input.client, deletion.scheduleId),
				)
			}
			if (url.pathname === '/v1/schedules/describe') {
				const description = parseTemporalScheduleDescribeRequest(parsed)
				if (
					verification.idempotencyKey !==
					`schedule:${description.scheduleId}:describe:${String(description.desiredVersion)}`
				) {
					return respond(response, 400, { error: 'idempotency_key_mismatch' })
				}
				return respond(
					response,
					200,
					await describeTemporalSchedule(input.client, description.scheduleId),
				)
			}
			return respond(response, 404, { error: 'not_found' })
		} catch (error) {
			const message = error instanceof Error ? error.message : 'internal_error'
			const status =
				error instanceof WorkflowNotFoundError
					? 404
					: message === 'request_too_large'
						? 413
						: 400
			return respond(response, status, { error: message })
		}
	})
}

async function run() {
	const config = loadClientConnectConfig()
	const connection = await Connection.connect(config.connectionOptions)
	const client = new Client({ connection, namespace: config.namespace })
	const keys = parseTemporalSigningKeys(
		requiredEnv('TEMPORAL_GATEWAY_SIGNING_KEYS'),
	)
	const server = createTemporalGatewayServer({ client, keys })
	const port = Number(process.env['PORT'] ?? 8080)
	server.listen(port, '0.0.0.0')
	const shutdown = () => {
		server.close(() => {
			connection.close()
		})
	}
	process.once('SIGTERM', shutdown)
	process.once('SIGINT', shutdown)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	run().catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
}
