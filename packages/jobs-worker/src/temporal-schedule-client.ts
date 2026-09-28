import {
	createTemporalSignature,
	parseTemporalSigningKeys,
} from '@kody-internal/shared/temporal/signing.ts'
import {
	type TemporalScheduleDeleteRequest,
	type TemporalScheduleDescribeRequest,
	type TemporalScheduleDescription,
	type TemporalScheduleUpsertRequest,
} from '@kody-internal/shared/temporal/job-schedules.ts'
import { type JobsWorkerEnv } from './env.ts'

const maxResponseBytes = 64 * 1024

function required(value: string | undefined, name: string) {
	const trimmed = value?.trim()
	if (!trimmed) throw new Error(`Missing ${name}.`)
	return trimmed
}

async function scheduleRequest<T>(input: {
	env: JobsWorkerEnv
	path: string
	body: unknown
	idempotencyKey: string
	fetch?: typeof fetch
}) {
	const baseUrl = required(
		input.env.TEMPORAL_GATEWAY_URL,
		'TEMPORAL_GATEWAY_URL',
	)
	const key = parseTemporalSigningKeys(
		required(
			input.env.TEMPORAL_GATEWAY_SIGNING_KEYS,
			'TEMPORAL_GATEWAY_SIGNING_KEYS',
		),
	).at(0)
	if (!key) throw new Error('Missing current Temporal gateway signing key.')
	const body = JSON.stringify(input.body)
	const headers = await createTemporalSignature({
		key,
		method: 'POST',
		pathname: input.path,
		body,
		idempotencyKey: input.idempotencyKey,
	})
	const response = await (input.fetch ?? fetch)(new URL(input.path, baseUrl), {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body,
		signal: AbortSignal.timeout(10_000),
	})
	const text = await response.text()
	if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
		throw new Error('Temporal Schedule Gateway response is too large.')
	}
	if (!response.ok) {
		throw new Error(
			`Temporal Schedule Gateway returned ${String(response.status)}.`,
		)
	}
	return JSON.parse(text) as T
}

export function upsertTemporalSchedule(input: {
	env: JobsWorkerEnv
	request: TemporalScheduleUpsertRequest
	fetch?: typeof fetch
}) {
	return scheduleRequest<TemporalScheduleDescription>({
		env: input.env,
		path: '/v1/schedules/upsert',
		body: input.request,
		idempotencyKey: `schedule:${input.request.scheduleId}:upsert:${String(input.request.desiredVersion)}`,
		fetch: input.fetch,
	})
}

export function describeTemporalSchedule(input: {
	env: JobsWorkerEnv
	request: TemporalScheduleDescribeRequest
	fetch?: typeof fetch
}) {
	return scheduleRequest<TemporalScheduleDescription>({
		env: input.env,
		path: '/v1/schedules/describe',
		body: input.request,
		idempotencyKey: `schedule:${input.request.scheduleId}:describe:${String(input.request.desiredVersion)}`,
		fetch: input.fetch,
	})
}

export function deleteTemporalSchedule(input: {
	env: JobsWorkerEnv
	request: TemporalScheduleDeleteRequest
	fetch?: typeof fetch
}) {
	return scheduleRequest<{ scheduleId: string; deleted: true }>({
		env: input.env,
		path: '/v1/schedules/delete',
		body: input.request,
		idempotencyKey: `schedule:${input.request.scheduleId}:delete:${String(input.request.desiredVersion)}`,
		fetch: input.fetch,
	})
}
