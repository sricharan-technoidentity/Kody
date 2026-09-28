import { handleSecretMaintenanceRequest } from '#worker/maintenance-handler.ts'
import { startTemporalFoundationWorkflow } from './client.ts'

type TemporalMaintenanceEnv = Env & {
	TEMPORAL_GATEWAY_URL?: string
	TEMPORAL_GATEWAY_SIGNING_KEYS?: string
}

export async function runTemporalFoundationSmokeCheck(
	env: TemporalMaintenanceEnv,
	fetchImplementation: typeof fetch = fetch,
) {
	const id = crypto.randomUUID()
	const workflowId = `temporal-foundation-smoke-${id}`
	const userHash = `smoke-${id}`
	const result = await startTemporalFoundationWorkflow({
		env,
		workflowId,
		fetch: fetchImplementation,
		request: {
			workflowId,
			userHash,
			sourceRef: `artifact:temporal-foundation-smoke@${'a'.repeat(40)}`,
		},
	})
	return {
		workflowId: result.workflowId,
		firstExecutionRunId: result.firstExecutionRunId,
		proves: 'cloudflare-to-temporal-to-cloudflare-signed-round-trip',
	}
}

export function handleTemporalFoundationSmokeRequest(
	request: Request,
	env: TemporalMaintenanceEnv,
) {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Temporal foundation smoke check is not configured',
		run: async () => await runTemporalFoundationSmokeCheck(env),
	})
}
