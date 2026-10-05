import { format } from 'oxfmt'
import formatterConfig from '#oxfmt.config.ts'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createS3Objects } from '#worker/aws/s3-objects.ts'
import { runLogObjectKey } from '#worker/aws/dynamo-runs.ts'
import { createKmsEnvelope } from '#worker/aws/kms-envelope.ts'
import { createAgentCoreTokenVault } from '#worker/aws/agentcore-identity.ts'
import { createBedrockEmbeddings } from '#worker/aws/bedrock-embeddings.ts'
import { createSesMail } from '#worker/aws/ses-mail.ts'
import { provePostgres } from './aws-postgres.ts'
import { proveDynamo } from './aws-dynamo.ts'
import { proveInterpreter } from './aws-interpreter.ts'
import { proveRuntime } from './aws-runtime.ts'
import {
	readAwsConfig,
	PendingProof,
	type AwsProofConfig,
} from './aws-config.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'

export type ProofResult = {
	service: string
	status: 'passed' | 'failed' | 'pending'
	evidence: unknown
}
function pending(section: unknown, name: string): asserts section {
	if (!section)
		throw new PendingProof(`Configure an existing sandbox ${name} resource.`)
}
export async function runAwsProofs(
	config?: AwsProofConfig,
): Promise<Array<ProofResult>> {
	const checks: Record<string, (config: AwsProofConfig) => Promise<unknown>> = {
		postgres: provePostgres,
		dynamodb: proveDynamo,
		async s3(c) {
			pending(c.s3, 'S3 bucket')
			const bucket = createS3Objects({ region: c.region, bucket: c.s3.bucket })
			const owner = `poc-proof-${randomUUID()}`
			const runId = randomUUID()
			const keys = [
				`${owner}/runner-inputs/${runId}.json`,
				runLogObjectKey(owner, runId),
			]
			try {
				for (const key of keys) {
					await bucket.put(key, 'Synthetic POC artifact')
					assert.equal(
						await (await bucket.get(key))?.text(),
						'Synthetic POC artifact',
					)
				}
				return {
					resource: c.s3.bucket,
					keys,
					roundTrip: true,
					cleanup: 'two proof-owned objects',
				}
			} finally {
				await bucket.delete(keys)
			}
		},
		async kms(c) {
			pending(c.kms, 'KMS key')
			const kms = createKmsEnvelope({ region: c.region, keyId: c.kms.keyId })
			const userId = `poc-proof-${randomUUID()}`
			const bytes = new TextEncoder().encode('Synthetic POC secret')
			const encrypted = await kms.encrypt(bytes, { userId })
			assert.deepEqual(await kms.decrypt(encrypted, { userId }), bytes)
			await assert.rejects(() =>
				kms.decrypt(encrypted, { userId: `${userId}-bob` }),
			)
			return {
				resource: c.kms.keyId,
				envelopeRoundTrip: true,
				otherOwnerRejected: true,
			}
		},
		runtime: proveRuntime,
		interpreter: proveInterpreter,
		async identity(c) {
			pending(c.identity, 'authorized Identity connection')
			const token = await createAgentCoreTokenVault({
				region: c.region,
				workloadName: c.identity.workload,
			}).fetch(c.identity.userId, c.identity.provider, c.identity.scopes)
			if (!token)
				throw new PendingProof(
					'Existing user/provider consent is required; no consent flow was started.',
				)
			return {
				resource: c.identity.provider,
				workload: c.identity.workload,
				authorizedTokenRetrieved: true,
			}
		},
		async embeddings(c) {
			pending(c.embeddings, 'Bedrock model')
			if (!c.postgres)
				throw new PendingProof(
					'Bedrock vector-search proof also requires configured PostgreSQL.',
				)
			const [vector] = await createBedrockEmbeddings({
				region: c.region,
				modelId: c.embeddings.modelId,
			}).embedTexts(['Synthetic POC report memory'])
			assert(vector)
			const database = await provePostgres(c, vector)
			return {
				resource: c.embeddings.modelId ?? 'amazon.titan-embed-text-v2:0',
				dimensions: vector.length,
				vectorSearch: database,
			}
		},
		async ses(c) {
			pending(c.ses, 'SES verified sender')
			const result = await createSesMail({ region: c.region }).send({
				from: c.ses.from,
				to: 'success@simulator.amazonses.com',
				subject: 'Synthetic Kody POC proof',
				html: '<p>Synthetic POC message.</p>',
				text: 'Synthetic POC message.',
				replyTo: undefined,
				headers: undefined,
				attachments: undefined,
			})
			return {
				resource: c.ses.from,
				recipient: 'success@simulator.amazonses.com',
				messageId: result.messageId,
			}
		},
	}
	const results: Array<ProofResult> = []
	for (const [service, check] of Object.entries(checks)) {
		if (!config) {
			results.push({
				service,
				status: 'pending',
				evidence: 'No separate AWS sandbox configuration supplied.',
			})
			continue
		}
		try {
			results.push({ service, status: 'passed', evidence: await check(config) })
		} catch (error) {
			results.push({
				service,
				status: error instanceof PendingProof ? 'pending' : 'failed',
				evidence:
					error instanceof PendingProof
						? error.message
						: {
								errorName: error instanceof Error ? error.name : 'UnknownError',
								httpStatus: (
									error as { $metadata?: { httpStatusCode?: number } }
								)?.$metadata?.httpStatusCode,
							},
			})
		}
	}
	return results
}
if (isExecutedDirectly(import.meta.url))
	void (async () => {
		const results = await runAwsProofs(await readAwsConfig())
		const evidencePath = 'docs/poc/aws-evidence.json'
		const formatted = await format(
			evidencePath,
			JSON.stringify({ checkedAt: new Date().toISOString(), results }),
			formatterConfig,
		)
		if (formatted.errors.length)
			throw new Error('AWS evidence formatting failed')
		await writeFile(evidencePath, formatted.code)

		console.table(
			results.map(({ service, status, evidence }) => ({
				service,
				status,
				evidence: JSON.stringify(evidence),
			})),
		)
		if (results.some((result) => result.status === 'failed'))
			process.exitCode = 1
	})().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : 'AWS proof configuration failed',
		)
		process.exitCode = 1
	})
