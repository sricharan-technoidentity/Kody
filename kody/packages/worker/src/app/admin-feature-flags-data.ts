import { type AdminFeatureFlagsLoaderData } from '#universal/loader-data.ts'
import { listFeatureFlagsForAdmin } from '#worker/feature-flags/service.ts'
import { attachFeatureFlagMetricReadouts } from '#worker/feature-flags/success-metric-readout.ts'

export async function loadAdminFeatureFlagsData(
	env: Env,
): Promise<AdminFeatureFlagsLoaderData> {
	const featureFlags = await listFeatureFlagsForAdmin(env.APP_DB)
	await attachFeatureFlagMetricReadouts(
		{ ...env, APP_DB: env.ANALYTICS_DB ?? env.APP_DB },
		featureFlags,
	)
	return {
		ok: true,
		featureFlags,
	}
}
