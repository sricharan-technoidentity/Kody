import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { type Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	authorizeOAuthClient,
	closeMcpConnection,
	connectMcpClient,
	exchangeAuthorizationCode,
	loginToApp,
	registerOAuthClient,
} from '#tools/mcp-oauth-client.ts'
import { demoControl, readDemoState } from './state.ts'
import { isExecutedDirectly } from '#tools/node-runtime.ts'

const users = {
	alice: {
		email: 'alice@example.invalid',
		username: 'alice',
		password: 'demo-password-123',
	},
	bob: {
		email: 'bob@example.invalid',
		username: 'bob',
		password: 'demo-password-123',
	},
}

async function connect(origin: string, user: typeof users.alice) {
	const cookie = await loginToApp(origin, user)
	const registration = await registerOAuthClient(origin, {
		clientName: 'Kody local demo',
	})
	const code = await authorizeOAuthClient(origin, registration, cookie)
	const token = await exchangeAuthorizationCode(origin, registration, code)
	const connection = await connectMcpClient(origin, {
		Authorization: `Bearer ${token}`,
	})
	return { ...connection, cookie }
}

async function execute<T>(
	client: Client,
	code: string,
	params?: Record<string, unknown>,
): Promise<T> {
	const result = (await client.callTool({
		name: 'execute',
		arguments: { code, ...(params ? { params } : {}) },
	})) as CallToolResult
	const structured = result.structuredContent as
		| { result?: T; error?: unknown }
		| undefined
	assert(!result.isError && !structured?.error, JSON.stringify(result))
	return structured?.result as T
}
function capability<T>(
	client: Client,
	name: string,
	params: Record<string, unknown> = {},
) {
	return execute<T>(
		client,
		`import { kody } from 'kody:runtime'; export default async (input) => kody.${name}(input);`,
		params,
	)
}
async function waitFor<T>(
	probe: () => Promise<T | undefined>,
	timeout = 90000,
) {
	const deadline = Date.now() + timeout
	for (;;) {
		const result = await probe()
		if (result !== undefined) return result
		if (Date.now() > deadline) throw new Error('Demo outcome timed out.')
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}

/** Real OAuth/MCP transport and existing capabilities, over the running demo. */
export async function runDemoScenario() {
	const { origin, temporalUi } = await readDemoState()
	const info = (await demoControl('info')) as {
		packageId: string
		aliceId: string
		webhookUrl: string
		retryAttempts: number
	}
	const stack = new AsyncDisposableStack()
	try {
		const alice = await connect(origin, users.alice)
		stack.defer(() => closeMcpConnection(alice))
		const bob = await connect(origin, users.bob)
		stack.defer(() => closeMcpConnection(bob))
		const run = randomUUID()
		const tools = await alice.client.listTools()
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
			'execute',
			'search',
		])
		const discovered = (await alice.client.callTool({
			name: 'search',
			arguments: { query: 'memory verify upsert search', limit: 10 },
		})) as CallToolResult
		assert(!discovered.isError)
		const candidate = {
			subject: `Approved demo memory ${run}`,
			summary: `Synthetic report marker ${run}`,
			category: 'demo',
			dedupe_key: `demo-${run}`,
		}
		await capability(alice.client, 'metaMemoryVerify', candidate)
		const memory = await capability<{ memory: { id: string } }>(
			alice.client,
			'metaMemoryUpsert',
			{
				...candidate,
				verified_by_agent: true,
				verification_reference: 'scripted-demo-human-approved',
			},
		)
		const matches = await capability<{ matches: Array<{ id: string }> }>(
			alice.client,
			'metaMemorySearch',
			{ query: run },
		)
		assert(matches.matches.some((match) => match.id === memory.memory.id))
		console.info(
			`Memory/MCP passed: ${memory.memory.id}\nOpen ${origin}/account/memories`,
		)

		const session = await capability<{ id: string }>(
			alice.client,
			'repoOpenSession',
			{ target: { kind: 'package', package_id: info.packageId } },
		)
		const version = `POC report ${run}`
		await capability(alice.client, 'repoEditFiles', {
			session_id: session.id,
			edits: [
				{
					kind: 'write',
					path: 'app.ts',
					content: `export default async () => new Response(${JSON.stringify(version)}, { headers: { 'content-type': 'text/plain' } });\n`,
				},
			],
		})
		await capability(alice.client, 'repoCommit', {
			session_id: session.id,
			message: 'Update synthetic report output',
		})
		const checks = await capability<{ ok: boolean }>(
			alice.client,
			'repoRunChecks',
			{ session_id: session.id },
		)
		assert(checks.ok, JSON.stringify(checks))
		const published = await capability<{
			status: string
			published_commit: string
		}>(alice.client, 'repoPublishSession', { session_id: session.id })
		assert.equal(published.status, 'ok')
		const appUrl = `${origin}/@alice/packages/report`
		const app = await fetch(appUrl, { headers: { Cookie: alice.cookie } })
		assert.equal(app.status, 200)
		assert.equal(await app.text(), version)
		console.info(
			`Edit/publish passed: ${published.published_commit}\nPublished app ${appUrl}`,
		)

		const deniedWebhook = new URL(info.webhookUrl)
		deniedWebhook.pathname = deniedWebhook.pathname.replace(
			/[^/]+$/,
			'invalid-demo-secret',
		)
		const deniedResponse = await fetch(deniedWebhook, {
			method: 'POST',
			headers: { 'content-type': 'application/json', Cookie: bob.cookie },
			body: JSON.stringify({ label: `unauthorized-${run}` }),
		})
		assert.equal(deniedResponse.status, 404)
		await deniedResponse.body?.cancel()
		const body = JSON.stringify({ label: `webhook-${run}` })
		const delivery = () =>
			fetch(info.webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'Idempotency-Key': run },
				body,
			})
		const first = await delivery()
		assert.equal(first.status, 200, await first.clone().text())
		const firstResult = await first.json()
		const second = await delivery()
		assert.equal(second.status, 200)
		const secondResult = (await second.json()) as {
			idempotency?: { replayed?: boolean }
		}
		assert(secondResult.idempotency?.replayed, JSON.stringify(secondResult))
		const storageId = `package:${encodeURIComponent(info.packageId)}`
		const rows = await capability<{ rows: Array<{ label: string }> }>(
			alice.client,
			'storageQuery',
			{
				storage_id: storageId,
				query: 'SELECT id, label FROM reports ORDER BY id',
			},
		)
		assert.equal(
			rows.rows.filter((row) => row.label === `webhook-${run}`).length,
			1,
		)
		console.info(
			`Duplicate webhook passed: one report row. Result ${JSON.stringify(firstResult)}`,
		)

		const jobs = await capability<{ jobs: Array<{ id: string }> }>(
			alice.client,
			'jobList',
		)
		assert.equal(jobs.jobs.length, 1)
		const job = jobs.jobs[0]!
		await capability(alice.client, 'jobUpdate', {
			id: job.id,
			enabled: true,
			params: { label: `schedule-${run}` },
			schedule: {
				type: 'once',
				run_at: new Date(Date.now() + 3000).toISOString(),
			},
		})
		await waitFor(async () => {
			const next = await capability<{ rows: Array<{ label: string }> }>(
				alice.client,
				'storageQuery',
				{ storage_id: storageId, query: 'SELECT label FROM reports' },
			)
			return next.rows.some((row) => row.label === `schedule-${run}`)
				? true
				: undefined
		})
		await capability(alice.client, 'jobUpdate', { id: job.id, enabled: false })
		console.info(
			`Scheduled package passed: job ${job.id}\nTemporal ${temporalUi}/namespaces/default/workflows`,
		)

		const retry = await execute<{ id: string }>(
			alice.client,
			`import { workflows } from 'kody:runtime'; export default async () => workflows.create({ workflowName: 'demo-pre-execution-retry', code: ${JSON.stringify(`import report from 'kody:@alice/report'; export default async () => report({label: 'retry-${run}'});`)}, idempotencyKey: ${JSON.stringify(`retry-${run}`)} });`,
		)
		await waitFor(async () => {
			const result = await capability<{
				workflows: Array<{ id: string; status: string }>
			}>(alice.client, 'workflowRunList', { limit: 25 })
			return result.workflows.some(
				(workflow) =>
					workflow.id === retry.id && workflow.status === 'complete',
			)
				? true
				: undefined
		}, 120000)
		const deferred = await execute<{ id: string }>(
			alice.client,
			`import { workflows } from 'kody:runtime'; export default async () => workflows.create({ workflowName: 'demo-worker-restart', code: ${JSON.stringify(`import report from 'kody:@alice/report'; export default async () => report({label: 'restart-${run}'});`)}, runAt: ${JSON.stringify(new Date(Date.now() + 5000).toISOString())}, idempotencyKey: ${JSON.stringify(`restart-${run}`)} });`,
		)
		await demoControl('restart-workers', {})
		await waitFor(async () => {
			const result = await capability<{
				workflows: Array<{ id: string; status: string }>
			}>(alice.client, 'workflowRunList', { limit: 25 })
			return [retry.id, deferred.id].every((id) =>
				result.workflows.some(
					(workflow) => workflow.id === id && workflow.status === 'complete',
				),
			)
				? true
				: undefined
		}, 120000)
		const finalRows = await capability<{ rows: Array<{ label: string }> }>(
			alice.client,
			'storageQuery',
			{ storage_id: storageId, query: 'SELECT label FROM reports' },
		)
		assert(!finalRows.rows.some((row) => row.label === `unauthorized-${run}`))
		for (const label of [`retry-${run}`, `restart-${run}`])
			assert.equal(
				finalRows.rows.filter((row) => row.label === label).length,
				1,
			)
		const after = (await demoControl('info')) as { retryAttempts: number }
		assert.equal(after.retryAttempts - info.retryAttempts, 2)
		console.info(
			`Safe pre-execution retry passed: ${retry.id}\nWorker restart passed: ${deferred.id}`,
		)

		const bobMemory = await capability<{ matches: Array<{ id: string }> }>(
			bob.client,
			'metaMemorySearch',
			{ query: run },
		)
		assert(!bobMemory.matches.some((match) => match.id === memory.memory.id))
		await assert.rejects(() =>
			capability(bob.client, 'packageGet', { package_id: info.packageId }),
		)
		const bobStorage = await execute(
			bob.client,
			`import { kody } from 'kody:runtime'; export default async () => {try {return await kody.storageQuery({storage_id: ${JSON.stringify(storageId)}, query:'SELECT label FROM reports'});} catch {return {denied:true};}}`,
		)
		assert.deepEqual(bobStorage, { denied: true })
		const aliceRuns = await capability<{ runs: Array<{ id: string }> }>(
			alice.client,
			'runList',
			{ limit: 20 },
		)
		assert(aliceRuns.runs.length > 0)
		await assert.rejects(() =>
			capability(bob.client, 'runGet', { run_id: aliceRuns.runs[0]!.id }),
		)
		console.info(
			`Bob isolation passed. Sign in at ${origin}/login\nCombined local demo passed (${run}).`,
		)
		return {
			run,
			memoryId: memory.memory.id,
			publishedCommit: published.published_commit,
			retryWorkflowId: retry.id,
			deferredWorkflowId: deferred.id,
		}
	} finally {
		await stack.disposeAsync()
	}
}
if (isExecutedDirectly(import.meta.url))
	void runDemoScenario().catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
