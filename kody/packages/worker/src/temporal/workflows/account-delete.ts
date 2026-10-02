import { proxyActivities } from '@temporalio/workflow'
import {
	type AccountDeleteInput,
	type CatalogActivities,
} from '../activities/catalog-types.ts'

const { deleteAccount } = proxyActivities<
	Pick<CatalogActivities, 'deleteAccount'>
>({
	startToCloseTimeout: '30 minutes',
	// The existing saga has destructive provider calls. A lost reply needs
	// operator recovery until every backend supports retry-safe deletion (P6).
	retry: { maximumAttempts: 1 },
})

/** Existing inventory/billing/cleanup saga preserves its user-row-last rule. */
export async function AccountDelete(input: AccountDeleteInput) {
	return deleteAccount(input)
}
