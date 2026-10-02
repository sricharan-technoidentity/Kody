import {
	DynamoDBClient,
	type DeleteItemCommand,
	type GetItemCommand,
	type GetItemCommandOutput,
	type PutItemCommand,
	type QueryCommand,
	type QueryCommandOutput,
	type TransactWriteItemsCommand,
	type UpdateItemCommand,
	type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb'

export type DynamoCommand =
	| GetItemCommand
	| PutItemCommand
	| UpdateItemCommand
	| DeleteItemCommand
	| QueryCommand
	| TransactWriteItemsCommand

export type DynamoOutput = Partial<
	GetItemCommandOutput & UpdateItemCommandOutput & QueryCommandOutput
>

/** One `send` for every DynamoDB adapter; tests inject it to assert command shapes. */
export type DynamoSend = (command: DynamoCommand) => Promise<DynamoOutput>

export function dynamoSend(input: {
	region: string
	send?: DynamoSend
}): DynamoSend {
	if (input.send) return input.send
	const client = new DynamoDBClient({ region: input.region })
	return (command) => client.send(command as GetItemCommand)
}

/** The item DynamoDB returned with `ReturnValuesOnConditionCheckFailure`, or rethrow. */
export function conditionalCheckFailedItem(error: unknown) {
	if (
		error instanceof Error &&
		error.name === 'ConditionalCheckFailedException'
	) {
		return (error as { Item?: GetItemCommandOutput['Item'] }).Item ?? null
	}
	throw error
}

/**
 * Cancellation codes of a `TransactWriteItems` that failed only on
 * conditions (one per item, `'None'` for items that passed); rethrows
 * anything else.
 */
export function transactionCancellationCodes(error: unknown) {
	if (error instanceof Error && error.name === 'TransactionCanceledException') {
		const reasons =
			(error as { CancellationReasons?: Array<{ Code?: string }> })
				.CancellationReasons ?? []
		const codes = reasons.map((reason) => reason.Code ?? 'None')
		if (
			codes.every(
				(code) => code === 'None' || code === 'ConditionalCheckFailed',
			)
		) {
			return codes
		}
	}
	throw error
}

/**
 * Throttling and service-side failures the SDK already retried with backoff.
 * Callers on best-effort paths may drop them instead of reporting each blip.
 */
export function isDynamoTransientError(error: unknown) {
	return (
		error instanceof Error &&
		[
			'ProvisionedThroughputExceededException',
			'ThrottlingException',
			'RequestLimitExceeded',
			'InternalServerError',
		].includes(error.name)
	)
}

export const epochSeconds = (ms: number) => Math.floor(ms / 1000)
