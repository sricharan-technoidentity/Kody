import assert from 'node:assert/strict'
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'node:crypto'
import { createDynamoUserMeters } from '#worker/aws/dynamo-meters.ts'
import {
	createDynamoIdempotency,
	createDynamoRunRecords,
} from '#worker/aws/dynamo-runs.ts'
import { type RunLogRowInput } from '#worker/run-records/run-log-types.ts'
import { PendingProof, type AwsProofConfig } from './aws-config.ts'

export async function proveDynamo(config: AwsProofConfig) {
	const tables = config.dynamo
	if (!tables)
		throw new PendingProof(
			'Configure existing meters, idempotency and run tables (pk/sk).',
		)
	const client = new DynamoDBClient({ region: config.region })
	const owner = `poc-proof-${randomUUID()}`
	const id = randomUUID()
	const day = new Date().toISOString().slice(0, 10)
	const keys = [
		{ table: tables.metersTable, sk: `execute_calls_per_day#${day}` },
		{ table: tables.idempotencyTable, sk: `execute#${id}` },
		{ table: tables.runsTable, sk: `run#${id}` },
	]
	try {
		const meter = createDynamoUserMeters({
			region: config.region,
			tableName: tables.metersTable,
		}).forUser(owner)
		const input = {
			resource: 'execute_calls_per_day' as const,
			day,
			limit: 1,
			updatedAt: new Date().toISOString(),
		}
		await meter.initialize({ ...input, count: 0 })
		const raced = await Promise.all([
			meter.consume(input),
			meter.consume(input),
		])
		assert.equal(
			raced.filter((result) => 'consumed' in result && result.consumed).length,
			1,
		)
		const claims = createDynamoIdempotency({
			region: config.region,
			idempotencyTable: tables.idempotencyTable,
		})
		const claim = { userId: owner, surface: 'execute', key: id, runId: id }
		assert.deepEqual(await claims.claimIdempotencyKey(claim), { claimed: true })
		assert.equal(
			(await claims.claimIdempotencyKey({ ...claim, runId: randomUUID() }))
				.claimed,
			false,
		)
		const records = createDynamoRunRecords({
			region: config.region,
			tableName: tables.runsTable,
			logs: {
				async put() {
					throw new Error('Proof never writes logs')
				},
				async get() {
					throw new Error('Proof never reads logs')
				},
				async delete() {
					throw new Error('Proof never deletes logs')
				},
			},
		})
		const now = new Date().toISOString()
		const run: RunLogRowInput = {
			id,
			surface: 'execute',
			status: 'running',
			name: 'Synthetic POC proof',
			packageId: null,
			kodyId: null,
			sourceId: null,
			publishedCommit: null,
			storageId: null,
			jobId: null,
			workflowId: null,
			invocationId: null,
			sessionId: null,
			idempotencyKey: null,
			parentRunId: null,
			startedAt: now,
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			metadataJson: '{}',
			createdAt: now,
			updatedAt: now,
		}
		await records.forUser(owner).startRun({ run })
		assert.equal(
			(await records.forUser(owner).getRun({ runId: id }))?.run.id,
			id,
		)
		assert.equal(
			await records.forUser(`${owner}-bob`).getRun({ runId: id }),
			null,
		)
		return {
			resources: tables,
			conditionalQuota: true,
			duplicateClaimProtected: true,
			ownerRunIsolation: true,
			cleanup: 'three proof-owned keys',
		}
	} finally {
		try {
			await Promise.all(
				keys.map(({ table, sk }) =>
					client.send(
						new DeleteItemCommand({
							TableName: table,
							Key: { pk: { S: owner }, sk: { S: sk } },
						}),
					),
				),
			)
		} finally {
			client.destroy()
		}
	}
}
