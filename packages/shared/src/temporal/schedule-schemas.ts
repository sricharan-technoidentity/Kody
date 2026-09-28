import { isRecord } from '../is-record.ts'
import { assertOpaqueTemporalIdentifier } from './identifiers.ts'
import {
	temporalJobTaskQueue,
	type TemporalScheduleDeleteRequest,
	type TemporalScheduleDescribeRequest,
	type TemporalScheduleSpecInput,
	type TemporalScheduleUpsertRequest,
} from './job-schedules.ts'

function exactKeys(
	record: Record<string, unknown>,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string> = [],
) {
	const allowed = new Set([...required, ...optional])
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`Unexpected field ${key}.`)
	}
	for (const key of required) {
		if (!(key in record)) throw new Error(`Missing ${key}.`)
	}
}

function record(value: unknown) {
	if (!isRecord(value)) throw new Error('Expected a JSON object.')
	return value
}

function string(recordValue: Record<string, unknown>, key: string, max = 200) {
	const value = recordValue[key]
	if (typeof value !== 'string' || !value || value.length > max) {
		throw new Error(`Invalid ${key}.`)
	}
	return value
}

function positiveInteger(recordValue: Record<string, unknown>, key: string) {
	const value = recordValue[key]
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Error(`Invalid ${key}.`)
	}
	return Number(value)
}

function nonnegativeInteger(recordValue: Record<string, unknown>, key: string) {
	const value = recordValue[key]
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error(`Invalid ${key}.`)
	}
	return Number(value)
}

function boolean(recordValue: Record<string, unknown>, key: string) {
	const value = recordValue[key]
	if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
	return value
}

function timestamp(value: string, key: string) {
	if (!value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Invalid ${key}.`)
	}
	return new Date(value).toISOString()
}

function optionalTimestamp(recordValue: Record<string, unknown>, key: string) {
	const value = recordValue[key]
	return value === undefined
		? undefined
		: timestamp(string(recordValue, key), key)
}

function parseIdentity(value: unknown) {
	const parsed = record(value)
	exactKeys(parsed, ['scheduleId', 'userHash', 'jobId', 'desiredVersion'])
	return {
		scheduleId: assertOpaqueTemporalIdentifier(
			string(parsed, 'scheduleId'),
			'scheduleId',
		),
		userHash: assertOpaqueTemporalIdentifier(
			string(parsed, 'userHash'),
			'userHash',
		),
		jobId: assertOpaqueTemporalIdentifier(string(parsed, 'jobId'), 'jobId'),
		desiredVersion: positiveInteger(parsed, 'desiredVersion'),
	}
}

function parseSpec(value: unknown): TemporalScheduleSpecInput {
	const parsed = record(value)
	const type = string(parsed, 'type', 20)
	switch (type) {
		case 'calendar': {
			exactKeys(
				parsed,
				['type', 'expression', 'timezone', 'startAt'],
				['endAt'],
			)
			const endAt = optionalTimestamp(parsed, 'endAt')
			return {
				type,
				expression: string(parsed, 'expression', 200),
				timezone: string(parsed, 'timezone', 100),
				startAt: timestamp(string(parsed, 'startAt'), 'startAt'),
				...(endAt ? { endAt } : {}),
			}
		}
		case 'interval': {
			exactKeys(parsed, ['type', 'every', 'offsetMs', 'startAt'], ['endAt'])
			const endAt = optionalTimestamp(parsed, 'endAt')
			return {
				type,
				every: string(parsed, 'every', 40),
				offsetMs: nonnegativeInteger(parsed, 'offsetMs'),
				startAt: timestamp(string(parsed, 'startAt'), 'startAt'),
				...(endAt ? { endAt } : {}),
			}
		}
		case 'once':
			exactKeys(parsed, ['type', 'runAt'])
			return {
				type,
				runAt: timestamp(string(parsed, 'runAt'), 'runAt'),
			}
		default:
			throw new Error('Invalid schedule spec type.')
	}
}

export function parseTemporalScheduleUpsertRequest(
	value: unknown,
): TemporalScheduleUpsertRequest {
	const parsed = record(value)
	exactKeys(parsed, [
		'scheduleId',
		'workflowId',
		'taskQueue',
		'userHash',
		'jobId',
		'desiredVersion',
		'enabled',
		'backend',
		'spec',
	])
	const identity = parseIdentity({
		scheduleId: parsed['scheduleId'],
		userHash: parsed['userHash'],
		jobId: parsed['jobId'],
		desiredVersion: parsed['desiredVersion'],
	})
	const taskQueue = assertOpaqueTemporalIdentifier(
		string(parsed, 'taskQueue'),
		'taskQueue',
	)
	if (taskQueue !== temporalJobTaskQueue) {
		throw new Error('Invalid Temporal job task queue.')
	}
	return {
		...identity,
		workflowId: assertOpaqueTemporalIdentifier(
			string(parsed, 'workflowId'),
			'workflowId',
		),
		taskQueue,
		enabled: boolean(parsed, 'enabled'),
		backend:
			string(parsed, 'backend', 20) === 'temporal'
				? 'temporal'
				: (() => {
						throw new Error('Invalid backend.')
					})(),
		spec: parseSpec(parsed['spec']),
	}
}

export function parseTemporalScheduleDeleteRequest(
	value: unknown,
): TemporalScheduleDeleteRequest {
	return parseIdentity(value)
}

export function parseTemporalScheduleDescribeRequest(
	value: unknown,
): TemporalScheduleDescribeRequest {
	return parseIdentity(value)
}
