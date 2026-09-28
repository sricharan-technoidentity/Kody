import { expect, test } from 'vitest'
import {
	assertLocalTemporalAddress,
	buildLocalCurrentVersionRequest,
} from '../src/set-local-current-version.ts'

test('local Worker Deployment routing accepts loopback addresses only', () => {
	expect(assertLocalTemporalAddress('localhost:7233')).toBe('localhost:7233')
	expect(assertLocalTemporalAddress('127.0.0.1:7233')).toBe('127.0.0.1:7233')
	expect(assertLocalTemporalAddress('[::1]:7233')).toBe('[::1]:7233')
	expect(() => assertLocalTemporalAddress('temporal.example.com:7233')).toThrow(
		'Refusing to change Worker Deployment routing on non-local Temporal address',
	)
})

test('local Worker Deployment routing defaults to the development build', () => {
	expect(buildLocalCurrentVersionRequest({}, 'default')).toEqual({
		namespace: 'default',
		deploymentName: 'kody-temporal-worker',
		buildId: 'development',
		identity: 'kody-local-temporal-bootstrap',
	})
	expect(
		buildLocalCurrentVersionRequest(
			{ KODY_TEMPORAL_BUILD_ID: 'local-build-2' },
			'local-namespace',
		),
	).toMatchObject({
		namespace: 'local-namespace',
		buildId: 'local-build-2',
	})
})
