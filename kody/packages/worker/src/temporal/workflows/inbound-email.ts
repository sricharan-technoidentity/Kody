import { proxyActivities } from '@temporalio/workflow'
import {
	type CatalogActivities,
	type InboundEmailInput,
} from '../activities/catalog-types.ts'

const { receiveEmail } = proxyActivities<
	Pick<CatalogActivities, 'receiveEmail'>
>({
	startToCloseTimeout: '5 minutes',
	retry: { maximumAttempts: 4 },
})

export async function InboundEmail(input: InboundEmailInput) {
	return receiveEmail(input)
}
