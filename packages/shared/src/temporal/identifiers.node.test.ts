import { expect, test } from 'vitest'
import {
	assertOpaqueTemporalIdentifier,
	buildJobOccurrenceWorkflowBaseId,
	buildJobScheduleId,
	buildTemporalJobHash,
} from './identifiers.ts'

test('Temporal identifiers accept the documented hashed prefixes without admitting personal identifiers', async () => {
	const scheduleId = await buildJobScheduleId(
		'private-user-id',
		'package-job:1',
	)
	const workflowId = await buildJobOccurrenceWorkflowBaseId(
		'private-user-id',
		'package-job:1',
	)
	const jobHash = await buildTemporalJobHash(
		'private-user-id',
		'package-job:pkg:archive%20sync%3A%20daily',
	)
	expect(assertOpaqueTemporalIdentifier(scheduleId, 'scheduleId')).toBe(
		scheduleId,
	)
	expect(assertOpaqueTemporalIdentifier(workflowId, 'workflowId')).toBe(
		workflowId,
	)
	expect(scheduleId).not.toContain('private-user-id')
	expect(jobHash).toMatch(/^[A-Za-z0-9_-]{32}$/)
	expect(jobHash).not.toContain('archive')
	expect(() =>
		assertOpaqueTemporalIdentifier('person@example.com', 'userHash'),
	).toThrow('bounded opaque identifier')
})
