import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { createAgentCoreRunner } from '#worker/aws/agentcore-runner.ts'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { runnerInputKey, runnerSessionId } from '#worker/runner/contract.ts'
import { type RunnerGraph } from '#worker/runner/contract.ts'
import { PendingProof, type AwsProofConfig } from './aws-config.ts'
import { prepareTemporal } from './prepare-temporal.ts'
import { denoVersion } from './prepare-deno.ts'

/** The default path uses real S3 and AgentCore; injection is only for local contract tests. */
export async function proveRuntime(
	config: AwsProofConfig,
	ports?: {
		objects: Pick<ReturnType<typeof createS3Objects>, 'put' | 'delete'>
		runner: ReturnType<typeof createAgentCoreRunner>
	},
) {
	const runtime = config.runtime
	if (!runtime)
		throw new PendingProof('Configure an existing sandbox AgentCore Runtime.')
	if (runtime.protocol !== 'kody-deno-v1')
		throw new PendingProof(
			'Existing runtime must implement kody-deno-v1; deployment remains external.',
		)
	if (!runtime.broker || !config.s3)
		throw new PendingProof(
			'Runtime proof requires an existing S3 bucket and HTTPS broker ingress reachable from the configured host.',
		)
	const url = new URL(runtime.broker.publicUrl)
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error(
			'Runtime proof broker ingress must be a trusted HTTPS origin.',
		)
	if (
		!Number.isSafeInteger(runtime.broker.port) ||
		runtime.broker.port < 1 ||
		runtime.broker.port > 65535
	)
		throw new Error(
			'Runtime proof broker listener requires a port from 1 to 65535.',
		)
	const executable = await prepareTemporal()
	const objects =
		ports?.objects ??
		createS3Objects({ region: config.region, bucket: config.s3.bucket })
	const runner =
		ports?.runner ??
		createAgentCoreRunner({ region: config.region, runtimeArn: runtime.arn })
	const userId = `poc-proof-${randomUUID()}`
	const runId = randomUUID()
	const key = runnerInputKey(userId, runId)
	const receipt = randomUUID()
	const signingKey = randomBytes(32).toString('hex')
	const broker = createBrokerHandler({ signingKey })
	const stack = new AsyncDisposableStack()
	let calls = 0
	let authorized = 0
	try {
		stack.defer(
			broker.register({
				userId,
				runId,
				async dispatch(capability, args) {
					assert.equal(capability, 'proof.record')
					assert.deepEqual(args, { runId })
					assert.equal(++calls, 1, 'Runner repeated the proof effect')
					return JSON.stringify({ result: receipt })
				},
			}),
		)
		stack.use(
			await startFrontDoorServer({
				host: '0.0.0.0',
				port: runtime.broker.port,
				async fetch(request) {
					const response = await broker.fetch(request)
					if (new URL(request.url).pathname === '/authorize' && response.ok)
						authorized++
					return response
				},
			}),
		)
		const graph: RunnerGraph = {
			mainModule: 'proof.js',
			compatibilityDate: '2026-04-16',
			compatibilityFlags: ['nodejs_compat'],
			method: 'evaluate',
			surface: 'aws-proof',
			providers: ['proof'],
			invocation: { runId },
			modules: {
				'proof.js': `export default { async evaluate({proof}, {runId}) { if (typeof Deno !== 'object' || Deno.version.deno !== ${JSON.stringify(denoVersion)}) throw new Error('Incompatible runner runtime'); const {result:receipt} = JSON.parse(await proof.call('record', JSON.stringify({runId}))); return {runId, receipt, protocol:'kody-deno-v1', denoVersion:Deno.version.deno}; } }`,
			},
		}
		stack.defer(() => objects.delete(key))
		await objects.put(key, JSON.stringify(graph))
		const runToken = await mintRunToken(signingKey, {
			userId,
			runId,
			expiresAt: Date.now() + 180000,
			retriever: false,
			provenance: [
				{ moduleId: 'proof.js', packageId: null, storageId: 'proof' },
			],
		})
		const temporal = await TestWorkflowEnvironment.createLocal({
			server: {
				ip: '127.0.0.1',
				executable: { type: 'existing-path', path: executable },
			},
		})
		stack.defer(() => temporal.teardown())
		const taskQueue = `runner-proof-${runId}`
		const expected = { runId, receipt, protocol: runtime.protocol, denoVersion }
		const worker = await Worker.create({
			connection: temporal.nativeConnection,
			namespace: 'default',
			taskQueue,
			workflowsPath: fileURLToPath(
				new URL('./aws-runtime-workflow.ts', import.meta.url),
			),
			activities: {
				async invokeReference() {
					const result = await runner.invoke({
						runtimeSessionId: runnerSessionId(userId, runId),
						payload: { bundleKey: key, runToken, runId },
					})
					assert.deepEqual(result, expected)
					assert.equal(calls, 1)
					assert.equal(
						authorized,
						1,
						'Runner must authorize before reading the graph',
					)
					await objects.put(
						`${userId}/runner-inputs/${runId}-result.json`,
						JSON.stringify(result),
					)
					return expected
				},
			},
		})
		const resultKey = `${userId}/runner-inputs/${runId}-result.json`
		stack.defer(() => objects.delete(resultKey))
		const workflowId = `${userId}:runner-proof:${runId}`
		const outcome = await worker.runUntil(() =>
			temporal.client.workflow.execute('runnerProof', {
				workflowId,
				taskQueue,
				args: [],
				workflowExecutionTimeout: '2 minutes',
			}),
		)
		assert.deepEqual(outcome, expected)
		return {
			resource: runtime.arn,
			protocol: runtime.protocol,
			workflowId,
			runtimeSessionId: runnerSessionId(userId, runId),
			referencedGraphExecuted: true,
			brokerCalls: calls,
			outcomeRecorded: true,
			cleanup:
				'two proof-owned S3 objects, broker registration and local Temporal server',
		}
	} catch (error) {
		let failure = error
		const causes: Array<string> = []
		while (failure instanceof Error && causes.length < 10) {
			causes.push(`${failure.name} ${failure.message}`)
			failure = failure.cause
		}
		if (
			calls === 0 &&
			authorized === 0 &&
			/(?:ECONN|ENOTFOUND|timeout|RuntimeClientError|ResourceNotFoundException|Runner invocation failed \(503\))/i.test(
				causes.join(' '),
			)
		)
			throw new PendingProof(
				'Configured Runtime or broker ingress is unavailable; no broker effect observed. Verify the existing host and connectivity.',
			)
		throw error
	} finally {
		await stack.disposeAsync()
	}
}
