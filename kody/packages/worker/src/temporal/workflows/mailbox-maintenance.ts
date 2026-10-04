import { proxyActivities } from '@temporalio/workflow'
import { type MailActivities } from '../mail-activities.ts'
const { maintainMailbox } = proxyActivities<
	Pick<MailActivities, 'maintainMailbox'>
>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 4 } })
export async function MailboxMaintenance(input: { userId: string }) {
	await maintainMailbox(input)
}
