import {
	type DynamicPackageWorkflowInput,
	type TemporalGatewayReconciliationRequest,
	type TemporalGatewayReconciliationResponse,
	type TemporalGatewayStartRequest,
	type TemporalGatewaySignalWithStartRequest,
	type TemporalGatewayWorkflowDescription,
} from '@kody-internal/shared/temporal/contracts.ts'
import { assertOpaqueTemporalIdentifier } from '@kody-internal/shared/temporal/identifiers.ts'
import {
	type Client,
	WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client'

const reconciliationUserHashMemoKey = 'kodyUserHash'
const reconciliationWorkflowRunIdMemoKey = 'kodyWorkflowRunId'
const reconciliationCallerContextRefMemoKey = 'kodyCallerContextRef'

function dynamicPackageReconciliationMemo(
	input: TemporalGatewayStartRequest,
): Record<string, string> | undefined {
	if (input.workflowType !== 'dynamicPackageWorkflow') return undefined
	const workflowInput = input.input as DynamicPackageWorkflowInput
	return {
		[reconciliationUserHashMemoKey]: workflowInput.userHash,
		[reconciliationWorkflowRunIdMemoKey]: workflowInput.workflowRunId,
		[reconciliationCallerContextRefMemoKey]: workflowInput.callerContextRef,
	}
}

export async function startTemporalWorkflow(
	client: Client,
	input: TemporalGatewayStartRequest,
) {
	try {
		const memo = dynamicPackageReconciliationMemo(input)
		const handle = await client.workflow.start(input.workflowType, {
			workflowId: input.workflowId,
			taskQueue: input.taskQueue,
			args: [input.input],
			...(memo ? { memo } : {}),
		})
		return {
			workflowId: handle.workflowId,
			firstExecutionRunId: handle.firstExecutionRunId,
		}
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
		const description = await client.workflow
			.getHandle(input.workflowId)
			.describe()
		return {
			workflowId: description.workflowId,
			firstExecutionRunId: description.runId,
		}
	}
}

export async function listTemporalWorkflowsForReconciliation(
	client: Client,
	input: TemporalGatewayReconciliationRequest,
): Promise<TemporalGatewayReconciliationResponse> {
	const executions: TemporalGatewayReconciliationResponse['executions'] = []
	for await (const execution of client.workflow.list({
		query: `WorkflowType = "${input.workflowType}" ORDER BY StartTime DESC`,
		pageSize: Math.min(input.limit + 1, 501),
	})) {
		const userHash = execution.memo?.[reconciliationUserHashMemoKey]
		const workflowRunId = execution.memo?.[reconciliationWorkflowRunIdMemoKey]
		const callerContextRef =
			execution.memo?.[reconciliationCallerContextRefMemoKey]
		executions.push({
			workflowId: execution.workflowId,
			workflowType: input.workflowType,
			status: execution.status.name,
			startedAt: execution.startTime.toISOString(),
			...(execution.closeTime
				? { closedAt: execution.closeTime.toISOString() }
				: {}),
			...(typeof userHash === 'string' ? { userHash } : {}),
			...(typeof workflowRunId === 'string' ? { workflowRunId } : {}),
			...(typeof callerContextRef === 'string' ? { callerContextRef } : {}),
		})
		if (executions.length > input.limit) break
	}
	return {
		executions: executions.slice(0, input.limit),
		truncated: executions.length > input.limit,
	}
}

export async function signalWithStartTemporalWorkflow(
	client: Client,
	input: TemporalGatewaySignalWithStartRequest,
) {
	const handle = await client.workflow.signalWithStart(input.workflowType, {
		workflowId: input.workflowId,
		taskQueue: input.taskQueue,
		args: [input.input],
		signal: input.signalName,
		signalArgs: input.signalArgs,
	})
	return {
		workflowId: handle.workflowId,
		signaledRunId: handle.signaledRunId,
	}
}

export async function cancelTemporalWorkflow(
	client: Client,
	workflowId: string,
) {
	const id = assertOpaqueTemporalIdentifier(workflowId, 'workflowId')
	await client.workflow.getHandle(id).cancel()
	return { workflowId: id, cancelled: true }
}

export async function describeTemporalWorkflow(
	client: Client,
	workflowId: string,
): Promise<TemporalGatewayWorkflowDescription> {
	const id = assertOpaqueTemporalIdentifier(workflowId, 'workflowId')
	const description = await client.workflow.getHandle(id).describe()
	return {
		workflowId: description.workflowId,
		runId: description.runId,
		workflowType: description.type,
		status: description.status.name,
		startedAt: description.startTime.toISOString(),
		...(description.closeTime
			? { closedAt: description.closeTime.toISOString() }
			: {}),
	}
}
