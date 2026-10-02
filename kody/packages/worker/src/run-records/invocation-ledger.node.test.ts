import { expect, test, vi } from 'vitest'
import { createDynamoInvocationLedger } from '#worker/aws/dynamo-invocation-ledger.ts'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createTestRunRecords } from '#worker/test-support/run-records.ts'
import {
	claimPackageInvocationRecord,
	finishPackageInvocationRecord,
	getPackageInvocationRecord,
	getRunRecord,
	exportRunRecords,
	clearRunRecords,
} from './service.ts'

vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
}))
const key = {
	tokenId: 'token-1',
	packageId: 'pkg-1',
	exportName: './send-message',
	idempotencyKey: 'evt-1',
}
const invocation = {
	...key,
	id: 'invocation-1',
	packageKodyId: 'pkg-one',
	requestHash: 'hash-1',
	source: 'webhook',
	topic: null,
}
function fixture() {
	let now = Date.now()
	const dynamo = createFakeDynamo()
	const ledger = createDynamoInvocationLedger({
		region: 'us-east-1',
		tableName: 'ledger',
		send: dynamo.send,
		now: () => now,
	})
	const runs = createTestRunRecords()
	const env = {
		...runs.env,
		RUN_STATE: {
			forUser(userId: string) {
				const rpc = ledger.forUser(userId)
				return {
					...rpc,
					async exportState() {
						return {
							packageInvocations: await rpc.list(),
							workflowProjections: [],
						}
					},
					clear: rpc.clear,
				}
			},
		},
	} as unknown as Env
	return {
		env,
		ledger,
		dynamo,
		advance(ms: number) {
			now += ms
		},
		reopen: () =>
			createDynamoInvocationLedger({
				region: 'us-east-1',
				tableName: 'ledger',
				send: dynamo.send,
				now: () => now,
			}),
	}
}

test('invocation claim, response replay, eager log, finish, export and account purge use the Dynamo adapter', async () => {
	const { env } = fixture()
	const claim = await claimPackageInvocationRecord({
		env,
		userId: 'alice',
		invocation,
		staleBefore: new Date(0).toISOString(),
		context: {
			surface: 'export',
			name: 'send-message',
			idempotencyKey: key.idempotencyKey,
			packageId: key.packageId,
		},
	})
	if (claim.outcome !== 'claimed' || !claim.handle)
		throw new Error('Expected claim')
	const duplicate = await claimPackageInvocationRecord({
		env,
		userId: 'alice',
		invocation: { ...invocation, id: 'second' },
		staleBefore: new Date(0).toISOString(),
		context: null,
	})
	expect(duplicate).toMatchObject({
		outcome: 'existing',
		record: { id: 'invocation-1', status: 'in_progress' },
	})
	expect(
		(
			await getRunRecord({ env, userId: 'alice', runId: claim.handle.id })
		)?.logs.map((row) => row.message),
	).toEqual(['package invocation started: send-message'])
	const responseJson = JSON.stringify({ status: 200, body: { sent: true } })
	expect(
		await finishPackageInvocationRecord({
			env,
			userId: 'alice',
			handle: claim.handle,
			invocationId: claim.invocationId,
			claimUpdatedAt: claim.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson,
			status: 'success',
			logs: ['sent'],
			result: { sent: true },
		}),
	).toEqual({ ledgerUpdated: true, record: null })
	expect(
		await getPackageInvocationRecord({ env, userId: 'alice', key }),
	).toMatchObject({ status: 'completed', responseJson })
	expect(
		await getPackageInvocationRecord({ env, userId: 'bob', key }),
	).toBeNull()
	expect(
		(await getRunRecord({ env, userId: 'alice', runId: claim.handle.id }))?.run,
	).toMatchObject({
		status: 'success',
		invocationId: 'invocation-1',
		metadata: { result: { sent: true } },
	})
	let cursor: string | null = null
	const exportedIds = []
	for (let index = 0; index < 6; index++) {
		const page = await exportRunRecords({
			env,
			userId: 'alice',
			pageSize: 1,
			startAfter: cursor,
		})
		exportedIds.push(...page.packageInvocations.map((row) => row.id))
		if (!page.truncated) break
		cursor = page.nextStartAfter
	}
	expect(exportedIds).toEqual(['invocation-1'])
	await clearRunRecords({ env, userId: 'alice' })
	expect(
		await getPackageInvocationRecord({ env, userId: 'alice', key }),
	).toBeNull()
	expect((await exportRunRecords({ env, userId: 'alice' })).runs).toEqual([])
})

test('racing stale reclaims preserve request hash, fence late finishes/releases, and release allows a retry', async () => {
	const fixtureState = fixture()
	const rpc = fixtureState.ledger.forUser('alice')
	const claimed = await rpc.claimPackageInvocation({
		invocation,
		staleBefore: new Date(0).toISOString(),
		run: null,
	})
	if (claimed.outcome !== 'claimed') throw new Error('Expected claim')
	fixtureState.advance(16 * 60 * 1000)
	const staleBefore = new Date(Date.now() + 60 * 1000).toISOString()
	expect(
		await rpc.claimPackageInvocation({
			invocation: { ...invocation, requestHash: 'changed' },
			staleBefore,
			run: null,
		}),
	).toMatchObject({ outcome: 'existing', record: { requestHash: 'hash-1' } })
	const [a, b] = await Promise.all([
		rpc.claimPackageInvocation({ invocation, staleBefore, run: null }),
		rpc.claimPackageInvocation({ invocation, staleBefore, run: null }),
	])
	expect([a.outcome, b.outcome].sort()).toEqual(['claimed', 'existing'])
	const owner = a.outcome === 'claimed' ? a : b
	if (owner.outcome !== 'claimed') throw new Error('Expected reclaimed owner')
	expect(owner.reclaimed).toBe(true)
	expect(
		await rpc.finishPackageInvocation({
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			status: 'failed',
			responseJson: 'old',
			run: null,
			logs: [],
		}),
	).toMatchObject({
		ledgerUpdated: false,
		record: { updatedAt: owner.claimUpdatedAt },
	})
	expect(
		await rpc.releasePackageInvocation({
			invocationId: owner.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			runId: null,
		}),
	).toMatchObject({ released: false })
	expect(
		await rpc.releasePackageInvocation({
			invocationId: owner.invocationId,
			claimUpdatedAt: owner.claimUpdatedAt,
			runId: null,
		}),
	).toEqual({ released: true, record: null })
	expect(
		await rpc.claimPackageInvocation({
			invocation: { ...invocation, id: 'retry' },
			staleBefore,
			run: null,
		}),
	).toMatchObject({
		outcome: 'claimed',
		invocationId: 'retry',
		reclaimed: false,
	})
})

test('completed responses survive adapter reopen for 90 days; expired replay is replaced even before TTL cleanup', async () => {
	const f = fixture()
	const rpc = f.ledger.forUser('alice')
	const claim = await rpc.claimPackageInvocation({
		invocation,
		staleBefore: new Date(0).toISOString(),
		run: null,
	})
	if (claim.outcome !== 'claimed') throw new Error('Expected claim')
	await rpc.finishPackageInvocation({
		invocationId: claim.invocationId,
		claimUpdatedAt: claim.claimUpdatedAt,
		status: 'completed',
		responseJson: 'cached',
		run: null,
		logs: [],
	})
	f.advance(89 * 86400000)
	expect(
		await f.reopen().forUser('alice').getPackageInvocation(key),
	).toMatchObject({ responseJson: 'cached' })
	f.advance(2 * 86400000)
	expect(await rpc.getPackageInvocation(key)).toBeNull()
	expect(
		await rpc.claimPackageInvocation({
			invocation: { ...invocation, id: 'after-ttl' },
			staleBefore: new Date(0).toISOString(),
			run: null,
		}),
	).toMatchObject({ outcome: 'claimed', invocationId: 'after-ttl' })
	f.advance(91 * 86400000)
	expect(await rpc.getPackageInvocation(key)).toMatchObject({
		id: 'after-ttl',
		status: 'in_progress',
	})
})
