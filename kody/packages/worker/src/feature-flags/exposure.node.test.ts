import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { expect, test, vi } from 'vitest'
import { recordFeatureFlagExposures } from './exposure.ts'
import { recordPaidRankedSearchFlagExposure } from './paid-ranked-search-exposure.ts'
import { jevSearchRerankFlagKey } from '#universal/feature-flags/registry.ts'

test('skips exposure recording without measured flags or a stable user id', async () => {
	const writeDataPoint = vi.fn()
	const batch = vi.fn()

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
			APP_DB: { batch } as unknown as SqlDatabase,
		},
		{
			stableUserId: 'user-1',
			evaluations: {
				'demo-indicator': { enabled: true, source: 'global' },
			},
			timestamp: '2026-07-31T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()
	expect(batch).not.toHaveBeenCalled()

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: '',
			evaluations: {
				'demo-indicator': { enabled: true, source: 'default' },
			},
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()
})

test('evaluation chokepoint skips paid-ranked-search flags; dedicated site records them', async () => {
	const writeDataPoint = vi.fn()
	const evaluations = {
		[jevSearchRerankFlagKey]: { enabled: true, source: 'global' as const },
		'compact-mcp-server-instructions': {
			enabled: true,
			source: 'global' as const,
		},
	}

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: 'a'.repeat(64),
			evaluations,
			recordingSite: 'evaluation',
			timestamp: '2026-09-20T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining(['compact-mcp-server-instructions', 'on']),
	})

	writeDataPoint.mockClear()
	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: 'a'.repeat(64),
			evaluations: {
				[jevSearchRerankFlagKey]: { enabled: true, source: 'global' },
			},
			recordingSite: 'dedicated',
			timestamp: '2026-09-20T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([jevSearchRerankFlagKey, 'on', 'global']),
	})
})

test('recordPaidRankedSearchFlagExposure writes the caller evaluation for paid users only', async () => {
	const writeDataPoint = vi.fn()
	const stableUserId = 'b'.repeat(64)
	const evaluation = { enabled: true, source: 'global' as const }

	await recordPaidRankedSearchFlagExposure({
		env: {
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		stableUserId,
		planEligible: false,
		evaluation,
	})
	expect(writeDataPoint).not.toHaveBeenCalled()

	await recordPaidRankedSearchFlagExposure({
		env: {
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		stableUserId,
		planEligible: true,
		evaluation,
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([jevSearchRerankFlagKey, 'on', 'global']),
	})
})

test('Postgres exposure upserts increment only the current user rollup', async () => {
	await using database = await createTestDb({ userId: 'alice' })
	const input = {
		stableUserId: 'alice',
		evaluations: {
			'compact-mcp-server-instructions': {
				enabled: true,
				source: 'global' as const,
			},
		},
		timestamp: '2026-09-30T00:00:00.000Z',
	}
	await recordFeatureFlagExposures({ APP_DB: database.db }, input)
	await recordFeatureFlagExposures({ APP_DB: database.db }, input)
	expect(
		(
			await database.reader
				.prepare(
					'SELECT user_id, exposure_count FROM feature_flag_exposure_rollups',
				)
				.all()
		).results,
	).toEqual([{ user_id: 'alice', exposure_count: 2 }])
	expect(
		(
			await database
				.forUser('bob')
				.reader.prepare('SELECT * FROM feature_flag_exposure_rollups')
				.all()
		).results,
	).toEqual([])
})
