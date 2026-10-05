import { invokeDenoSpike } from '../../../../tools/demo/deno-spike.ts'
import { createWorker } from '#worker/package-runtime/package-build-tools.ts'
import {
	type RunnerGraph,
	type RunnerInvocation,
} from '#worker/runner/contract.ts'
export { type RunnerGraph } from '#worker/runner/contract.ts'

/** Raw transport for retained synthetic graph fixtures, not an authorized service entry point. */
export async function createDenoFixtureRunner(input: {
	brokerUrl: string
	egressUrl: string
	readObject(key: string): Promise<RunnerGraph>
}) {
	return {
		createWorker,
		async invoke(invocation: RunnerInvocation) {
			return invokeDenoSpike({
				graph: await input.readObject(invocation.bundleKey),
				runToken: invocation.runToken,
				brokerUrl: input.brokerUrl,
				egressUrl: input.egressUrl,
			})
		},
		async [Symbol.asyncDispose]() {},
	}
}
