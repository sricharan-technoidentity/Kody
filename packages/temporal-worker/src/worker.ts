import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporalPackageActivityTaskQueue } from '@kody-internal/shared/temporal/contracts.ts'
import { loadClientConnectConfig } from '@temporalio/envconfig'
import { VersioningBehavior } from '@temporalio/common'
import {
	NativeConnection,
	Runtime,
	Worker,
	type RuntimeOptions,
} from '@temporalio/worker'
import * as activities from './activities/index.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultMetricsPort = 9464

export function buildTemporalRuntimeOptions(
	env: NodeJS.ProcessEnv = process.env,
): RuntimeOptions {
	const configuredAddress = env['TEMPORAL_METRICS_BIND_ADDRESS']?.trim()
	const bindAddress =
		configuredAddress ||
		`${env['NODE_ENV'] === 'production' ? '0.0.0.0' : '127.0.0.1'}:${String(defaultMetricsPort)}`
	return {
		telemetryOptions: {
			metrics: { prometheus: { bindAddress } },
		},
	}
}

async function loadWorkflowBundle() {
	if (process.env['NODE_ENV'] !== 'production') return undefined
	return {
		code: await readFile(
			resolve(packageRoot, 'dist/workflow-bundle.js'),
			'utf8',
		),
	}
}

function readPositiveIntegerEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) return undefined
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer.`)
	}
	return parsed
}

export async function createTemporalWorkers() {
	const config = loadClientConnectConfig()
	const connection = await NativeConnection.connect(config.connectionOptions)
	const workflowBundle = await loadWorkflowBundle()
	const taskQueue =
		process.env['TEMPORAL_TASK_QUEUE']?.trim() || 'kody-foundation'
	const buildId = process.env['KODY_TEMPORAL_BUILD_ID']?.trim() || 'development'
	const workerDeploymentOptions = {
		useWorkerVersioning: true,
		defaultVersioningBehavior: VersioningBehavior.PINNED,
		version: {
			deploymentName: 'kody-temporal-worker',
			buildId,
		},
	} as const
	const orchestrationWorker = await Worker.create({
		connection,
		namespace: config.namespace,
		taskQueue,
		activities: {
			resolvePackageReference: activities.resolvePackageReference,
			claimJobOccurrence: activities.claimJobOccurrence,
			resolveExecutionPlan: activities.resolveExecutionPlan,
			finalizeJobOccurrence: activities.finalizeJobOccurrence,
			refreshStripePlan: activities.refreshStripePlan,
		},
		...(workflowBundle
			? { workflowBundle }
			: {
					workflowsPath: resolve(packageRoot, 'src/workflows/index.ts'),
				}),
		shutdownGraceTime: '8 seconds',
		workerDeploymentOptions,
	})
	const maxConcurrentActivityTaskExecutions = readPositiveIntegerEnv(
		'TEMPORAL_PACKAGE_ACTIVITY_MAX_CONCURRENT_EXECUTIONS',
	)
	const packageActivityWorker = await Worker.create({
		connection,
		namespace: config.namespace,
		taskQueue: temporalPackageActivityTaskQueue,
		activities: {
			executePackageSandbox: activities.executePackageSandbox,
			executeDynamicPackageSandbox: activities.executeDynamicPackageSandbox,
		},
		shutdownGraceTime: '8 seconds',
		workerDeploymentOptions,
		...(maxConcurrentActivityTaskExecutions === undefined
			? {}
			: { maxConcurrentActivityTaskExecutions }),
	})
	return [orchestrationWorker, packageActivityWorker]
}

type RunnableWorker = {
	run(): Promise<void>
	shutdown(): void
}

type SignalSource = {
	once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
	off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
}

export type TemporalWorkerLifecycleEvent =
	| { state: 'shutdown_started' }
	| { state: 'shutdown_completed'; durationMs: number }

function logTemporalWorkerLifecycle(event: TemporalWorkerLifecycleEvent) {
	console.info('temporal_worker_lifecycle', event)
}

export async function runTemporalWorkers(
	workers: ReadonlyArray<RunnableWorker>,
	signalSource: SignalSource = process,
	recordLifecycle: (
		event: TemporalWorkerLifecycleEvent,
	) => void = logTemporalWorkerLifecycle,
	now: () => number = Date.now,
) {
	let shutdownStartedAt: number | undefined
	const shutdown = () => {
		if (shutdownStartedAt === undefined) {
			shutdownStartedAt = now()
			recordLifecycle({ state: 'shutdown_started' })
		}
		for (const worker of workers) worker.shutdown()
	}
	signalSource.once('SIGTERM', shutdown)
	signalSource.once('SIGINT', shutdown)
	try {
		await Promise.all(workers.map((worker) => worker.run()))
	} finally {
		signalSource.off('SIGTERM', shutdown)
		signalSource.off('SIGINT', shutdown)
		if (shutdownStartedAt !== undefined) {
			recordLifecycle({
				state: 'shutdown_completed',
				durationMs: Math.max(0, now() - shutdownStartedAt),
			})
		}
	}
}

async function run() {
	Runtime.install(buildTemporalRuntimeOptions())
	const workers = await createTemporalWorkers()
	await runTemporalWorkers(workers)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	run().catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
}
