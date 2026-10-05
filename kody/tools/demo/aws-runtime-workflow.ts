import { proxyActivities } from '@temporalio/workflow'

const { invokeReference } = proxyActivities<{
	invokeReference(): Promise<{
		runId: string
		receipt: string
		protocol: string
		denoVersion: string
	}>
}>({ startToCloseTimeout: '90 seconds', retry: { maximumAttempts: 1 } })

export async function runnerProof() {
	return invokeReference()
}
