import { expect, test, vi } from 'vitest'
import {
	executeDynamicWorkflowPayload,
	temporalDynamicPackageWorkflowsBindingName,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
}))

test('the retired Cloudflare Workflow binding is replaced by the Temporal projection binding', () => {
	expect(temporalDynamicPackageWorkflowsBindingName).toBe(
		'TEMPORAL_DYNAMIC_PACKAGE_WORKFLOWS',
	)
})

test('Temporal package activity attempts reuse the workflow invocation idempotency key', async () => {
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValue({
		status: 200,
		body: { result: { ok: true } },
	})
	const payload = {
		version: 2 as const,
		sourceType: 'package' as const,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: './run-event',
		exportName: './run-event',
		idempotencyKey: 'logical-workflow-operation',
		runAt: '2026-09-23T00:00:00.000Z',
		planDate: '2026-09-23',
		params: { eventId: 'event-1' },
	}
	const input = {
		env: { APP_BASE_URL: 'https://app.example.com' } as Env,
		payload,
		instanceId: 'dynwf-run-1',
		invocationIdempotencyKey: 'temporal-invocation-key',
	}

	await executeDynamicWorkflowPayload(input)
	await executeDynamicWorkflowPayload(input)

	expect(invocationMocks.invokePackageExport).toHaveBeenCalledTimes(2)
	for (const call of invocationMocks.invokePackageExport.mock.calls) {
		expect(call[0]).toEqual(
			expect.objectContaining({
				ephemeral: false,
				request: expect.objectContaining({
					idempotencyKey: 'temporal-invocation-key',
				}),
			}),
		)
	}
})
