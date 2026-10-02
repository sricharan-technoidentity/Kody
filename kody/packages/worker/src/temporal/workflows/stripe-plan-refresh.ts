import {
	condition,
	defineSignal,
	proxyActivities,
	setHandler,
} from '@temporalio/workflow'
import { type KodyActivities } from '../activities/types.ts'

export const rescheduleStripeRefresh = defineSignal<[number]>('reschedule')
const { refreshStripePlan } = proxyActivities<
	Pick<KodyActivities, 'refreshStripePlan'>
>({
	startToCloseTimeout: '5 minutes',
	retry: { initialInterval: '1 hour', backoffCoefficient: 1 },
})

/** A per-account debounce timer; subsequent activity moves the backstop. */
export async function StripePlanRefresh(input: {
	userId: string
	refreshAt: number
}) {
	let refreshAt = input.refreshAt
	let revision = 0
	setHandler(rescheduleStripeRefresh, (at) => {
		if (!Number.isFinite(at)) return
		refreshAt = at
		revision += 1
	})
	for (;;) {
		const seen = revision
		if (
			!(await condition(
				() => revision !== seen,
				Math.max(0, refreshAt - Date.now()),
			))
		)
			break
	}
	await refreshStripePlan({ userId: input.userId })
}
