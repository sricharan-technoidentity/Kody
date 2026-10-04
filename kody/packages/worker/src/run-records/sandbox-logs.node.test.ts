import { env } from '#worker/test-support/runner-suite.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { getRunRecord, listRunRecords } from './service.ts'

// P6: needs the sandbox (Worker Loader today, the AgentCore Runner after P6).

function uniqueUserId(label: string) {
	return `run-records-${label}-${crypto.randomUUID()}`
}

test(
	'logs from a real failing sandbox execution land in RunLog via getRunRecord',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = uniqueUserId('sandbox-fail-logs')
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
				email: 'sandbox-fail-logs@example.com',
				displayName: 'Sandbox Fail Logs',
			},
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					'export default async function main() {',
					"\tconsole.log('alpha')",
					"\tconsole.warn('heads up')",
					"\tconsole.error('captured error')",
					"\tthrow new Error('sandbox boom')",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'execute',
					name: 'failing-console-logs',
				},
			},
		)
		expect(result.error).toBe('sandbox boom')
		expect(result.logs).toEqual([
			'alpha',
			'[warn] heads up',
			'[error] captured error',
		])

		const page = await listRunRecords({
			env,
			userId,
			filter: { surface: 'execute', name: 'failing-console-logs' },
		})
		expect(page.runs).toHaveLength(1)
		expect(page.runs[0]?.status).toBe('error')
		expect(page.runs[0]?.errorMessage).toBe('sandbox boom')

		const detail = await getRunRecord({
			env,
			userId,
			runId: page.runs[0]!.id,
		})
		expect(detail).not.toBeNull()
		// The sandbox flattens console output to strings with a level marker;
		// persistence recovers the structured level so readers can filter and
		// colour by it rather than pattern-matching message text.
		expect(detail?.logs.map((entry) => [entry.level, entry.message])).toEqual([
			['log', 'alpha'],
			['warn', 'heads up'],
			['error', 'captured error'],
		])
	},
)
