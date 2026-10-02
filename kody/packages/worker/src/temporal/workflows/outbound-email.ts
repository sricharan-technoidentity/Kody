import { proxyActivities } from '@temporalio/workflow'
import {
	type CatalogActivities,
	type MailObjectInput,
} from '../activities/catalog-types.ts'

const { sendEmail } = proxyActivities<Pick<CatalogActivities, 'sendEmail'>>({
	startToCloseTimeout: '5 minutes',
	// Provider acceptance followed by a lost response cannot safely be resent.
	// The existing send service records uncertain persistence for reconciliation.
	retry: { maximumAttempts: 1 },
})

export async function OutboundEmail(input: MailObjectInput) {
	return sendEmail(input)
}
