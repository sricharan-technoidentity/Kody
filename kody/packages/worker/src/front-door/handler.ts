import { isAppEdgeRequest } from './app-edge.ts'
import {
	usesWriterAfterMutation,
	setWriterAfterMutation,
} from './read-write-split.ts'
import { randomUUID } from 'node:crypto'
import { type createAwsEnv } from './env.ts'
import { runWithHostContext } from './host-context.ts'
import {
	encodeRequest,
	encodeResponse,
	decodeRequest,
	decodeResponse,
	type HttpRequestPayload,
} from './http-payload.ts'
import {
	type FrontDoorMutation,
	type McpClientOperation,
} from '#worker/temporal/workflows/front-door-mutation.ts'
import { type ExposureInput } from '#worker/feature-flags/exposure.ts'
import { type KodyTemporal } from '#worker/temporal/client.ts'

export type FetchHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
}

const mutatingGetPaths = new Set([
	'/verify-email',
	'/verify-email-change',
	'/verify-email-claim-release',
	'/verify-email-destination',
	'/unsubscribe/tips',
	'/account/mcp-servers/oauth/callback',
	'/oauth/callback',
	'/logout',
	'/oidc/logout',
	'/mcp',
])
export function isHttpMutation(request: Request) {
	const path = new URL(request.url).pathname
	return (
		!['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
		mutatingGetPaths.has(path) ||
		path.startsWith('/oauth/') ||
		/^\/auth\/[^/]+\/callback$/.test(path)
	)
}

/** Durable forms/OAuth keep their original handlers inside a scoped activity. */
export function createFrontDoor(input: {
	env: ReturnType<typeof createAwsEnv>
	temporal: KodyTemporal
	handler: FetchHandler
}) {
	async function handle(
		request: Request,
		write: boolean,
		readAfterWrite = false,
	) {
		const env = await input.env.forRequest(request, write, readAfterWrite)
		if (!write)
			env.RECORD_FLAG_EXPOSURES = async (exposure) => {
				if (exposure.stableUserId !== env.REQUEST_USER_ID)
					throw new Error('Exposure owner mismatch.')
				const client = await input.temporal.client('app')
				await client.workflow.execute('FeatureFlagExposure', {
					workflowId: `${exposure.stableUserId}:exposure:${randomUUID()}`,
					taskQueue: 'app',
					args: [exposure],
				})
			}
		if (!write && env.MCP_CLIENTS) {
			const clients = env.MCP_CLIENTS
			env.MCP_CLIENTS = {
				forUser(owner: string) {
					if (owner !== env.REQUEST_USER_ID)
						throw new Error('MCP client owner mismatch.')
					return new Proxy(clients.forUser(owner), {
						get(_target, method: string) {
							if (typeof _target[method as keyof typeof _target] !== 'function')
								return undefined
							return async (...args: unknown[]) => {
								const client = await input.temporal.client('app')
								return client.workflow.execute('FrontDoorMcpOperation', {
									workflowId: `${owner}:mcp-http:${randomUUID()}`,
									taskQueue: 'app',
									args: [{ userId: owner, method, args }],
								})
							}
						},
					})
				},
			}
		}
		const pending: Array<Promise<unknown>> = []
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise)
			},
			exports: {},
			props: {},
			passThroughOnException() {},
		} as ExecutionContext
		try {
			const response = await runWithHostContext(ctx.waitUntil, () =>
				input.handler.fetch(request, env, ctx),
			)
			return response
		} finally {
			await Promise.allSettled(pending)
		}
	}
	return {
		async fetch(request: Request) {
			const scope = await input.env.forRequest(request, false)
			if (!isHttpMutation(request) && !isAppEdgeRequest(request, scope))
				return handle(
					request,
					false,
					usesWriterAfterMutation(request, input.env.cookieSecret),
				)
			const client = await input.temporal.client('app')
			const response = decodeResponse(
				await client.workflow.execute<typeof FrontDoorMutation>(
					'FrontDoorMutation',
					{
						workflowId: `${scope.REQUEST_USER_ID ?? randomUUID()}:http:${randomUUID()}`,
						taskQueue: 'app',
						args: [await encodeRequest(request)],
					},
				),
			)
			setWriterAfterMutation(response, request, input.env.cookieSecret)
			return response
		},
		activities: {
			async operateMcpClient(operation: McpClientOperation) {
				const clients = input.env.forUser(operation.userId, true).MCP_CLIENTS
				if (!clients) throw new Error('MCP clients are unavailable.')
				const target = clients.forUser(operation.userId)
				const method = target[operation.method as keyof typeof target]
				if (typeof method !== 'function')
					throw new Error('Unknown MCP client operation.')
				return (method as (...args: unknown[]) => Promise<unknown>).apply(
					target,
					operation.args,
				)
			},
			async recordExposure(exposure: ExposureInput) {
				const { recordFeatureFlagExposures } =
					await import('../feature-flags/exposure.ts')
				await recordFeatureFlagExposures(
					input.env.forUser(exposure.stableUserId, true),
					exposure,
				)
			},
			async handleHttpMutation(payload: HttpRequestPayload) {
				return encodeResponse(await handle(decodeRequest(payload), true))
			},
		},
	}
}
