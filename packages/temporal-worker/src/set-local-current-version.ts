import { fileURLToPath } from 'node:url'
import { Connection } from '@temporalio/client'
import { loadClientConnectConfig } from '@temporalio/envconfig'

export const temporalWorkerDeploymentName = 'kody-temporal-worker'

export function assertLocalTemporalAddress(address: string) {
	const normalized = address.trim().toLowerCase()
	if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(normalized)) {
		throw new Error(
			`Refusing to change Worker Deployment routing on non-local Temporal address: ${address}`,
		)
	}
	return normalized
}

export function buildLocalCurrentVersionRequest(
	env: NodeJS.ProcessEnv,
	namespace: string,
) {
	return {
		namespace,
		deploymentName: temporalWorkerDeploymentName,
		buildId: env['KODY_TEMPORAL_BUILD_ID']?.trim() || 'development',
		identity: 'kody-local-temporal-bootstrap',
	}
}

export async function setLocalCurrentVersion(
	env: NodeJS.ProcessEnv = process.env,
) {
	if (env['NODE_ENV'] === 'production') {
		throw new Error('Local Temporal bootstrap is disabled in production.')
	}
	const overrideEnvVars: Record<string, string> = {}
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) overrideEnvVars[name] = value
	}
	const config = loadClientConnectConfig({ overrideEnvVars })
	assertLocalTemporalAddress(
		config.connectionOptions.address ?? 'localhost:7233',
	)
	const connection = await Connection.connect(config.connectionOptions)
	try {
		await connection.workflowService.setWorkerDeploymentCurrentVersion(
			buildLocalCurrentVersionRequest(env, config.namespace ?? 'default'),
		)
	} finally {
		connection.close()
	}
}

async function run() {
	await setLocalCurrentVersion()
	console.info('Local Temporal worker deployment version is current.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	run().catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
}
