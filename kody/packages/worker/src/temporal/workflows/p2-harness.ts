import { sleep } from '@temporalio/workflow'

export async function harnessDelay(milliseconds: number) {
	await sleep(milliseconds)
	return 'elapsed'
}
