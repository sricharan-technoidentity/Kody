import {
	allHandlersFinished,
	condition,
	continueAsNew,
	defineQuery,
	defineUpdate,
	setHandler,
	workflowInfo,
} from '@temporalio/workflow'
import {
	creatingWorkflowProjectionStatus,
	workflowProjectionCreatingTtlMs,
	workflowProjectionReservationStatuses,
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
	type WorkflowProjectionReserveResult,
} from '#worker/run-records/workflow-projection.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { workflowProjectionRetentionDays } from '#worker/run-records/types.ts'

export const projectionRowsQuery =
	defineQuery<Array<WorkflowProjectionRecord>>('projectionRows')
export type ProjectionCommand =
	| { action: 'upsert' | 'reserve'; projection: WorkflowProjectionUpsertInput }
	| { action: 'delete'; id: string }
	| { action: 'clear' }
export const projectionUpdate = defineUpdate<
	{ ok: true } | { deleted: boolean } | WorkflowProjectionReserveResult,
	[ProjectionCommand]
>('projectionUpdate')

/** Reservation updates are synchronous in one owner workflow, independent of eventually consistent Visibility. */
export async function WorkflowProjectionRegistry(input: {
	userId: string
	rows?: Array<WorkflowProjectionRecord>
}) {
	if (workflowInfo().workflowId !== `${input.userId}:workflow-projections`)
		throw new Error('Projection registry owner mismatch.')
	const rows = new Map((input.rows ?? []).map((row) => [row.id, row]))
	const expired = (row: WorkflowProjectionRecord) =>
		row.status === creatingWorkflowProjectionStatus
			? Date.parse(row.updatedAt) + workflowProjectionCreatingTtlMs <=
				Date.now()
			: terminalWorkflowStatusValues.some((status) => status === row.status) &&
				Date.parse(row.completedAt ?? row.updatedAt) +
					workflowProjectionRetentionDays * 86400000 <=
					Date.now()
	const prune = () => {
		for (const [id, row] of rows) if (expired(row)) rows.delete(id)
	}

	const normalize = (
		value: WorkflowProjectionUpsertInput,
		previous?: WorkflowProjectionRecord,
	): WorkflowProjectionRecord => {
		const now = new Date().toISOString()
		return {
			id: value.id,
			bindingName: value.bindingName,
			sourceType: value.sourceType,
			packageId: value.packageId ?? previous?.packageId ?? null,
			kodyId: value.kodyId ?? previous?.kodyId ?? null,
			sourceId: value.sourceId ?? previous?.sourceId ?? null,
			workflowName: value.workflowName,
			exportName: value.exportName ?? previous?.exportName ?? null,
			idempotencyKey: value.idempotencyKey,
			runAt: value.runAt,
			planDate: value.planDate ?? previous?.planDate ?? null,
			status: value.status ?? previous?.status ?? null,
			createdAt: value.createdAt ?? previous?.createdAt ?? now,
			updatedAt: value.updatedAt ?? now,
			completedAt: value.completedAt ?? previous?.completedAt ?? null,
			lastError:
				value.lastError === undefined
					? (previous?.lastError ?? null)
					: value.lastError,
		}
	}
	setHandler(projectionRowsQuery, () =>
		[...rows.values()].filter((row) => !expired(row)),
	)
	setHandler(
		projectionUpdate,
		(command) => {
			prune()
			if (command.action === 'clear') {
				rows.clear()
				return { ok: true }
			}
			if (command.action === 'delete') {
				const row = rows.get(command.id)
				return {
					deleted:
						row?.status === creatingWorkflowProjectionStatus &&
						rows.delete(command.id),
				}
			}
			const value = command.projection
			const previous = rows.get(value.id)
			if (command.action === 'upsert') {
				const next = normalize(value, previous)
				const terminal = (status: string | null) =>
					terminalWorkflowStatusValues.some((value) => value === status)
				if (
					!previous ||
					(next.updatedAt >= previous.updatedAt &&
						!(terminal(previous.status) && !terminal(next.status)))
				)
					rows.set(value.id, next)
				return { ok: true }
			}
			const countBeforeReservation = [...rows.values()].filter(
				(row) =>
					row.id !== value.id &&
					workflowProjectionReservationStatuses.includes(row.status ?? ''),
			).length
			const projection =
				previous?.status != null &&
				previous.status !== creatingWorkflowProjectionStatus
					? previous
					: normalize(
							{ ...value, status: creatingWorkflowProjectionStatus },
							previous,
						)
			if (
				!previous ||
				previous.status == null ||
				previous.status === creatingWorkflowProjectionStatus
			)
				rows.set(value.id, projection)

			return {
				countBeforeReservation,
				reserved: projection.status === creatingWorkflowProjectionStatus,
				inserted: !previous,
				projection,
			}
		},
		{
			validator(command) {
				if (command.action !== 'clear') {
					const id =
						command.action === 'delete' ? command.id : command.projection.id
					if (!id.startsWith(`${input.userId}:`))
						throw new Error('Projection owner mismatch.')
				}
			},
		},
	)
	// ponytail: one registry per owner; shard only if one user's reservation throughput warrants it.
	await condition(() => workflowInfo().continueAsNewSuggested)
	await condition(allHandlersFinished)
	await continueAsNew<typeof WorkflowProjectionRegistry>({
		userId: input.userId,
		rows: [...rows.values()],
	})
}
