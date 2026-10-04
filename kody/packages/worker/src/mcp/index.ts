import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { assembleMcpServerInstructionsForCaller } from './assemble-mcp-server-instructions.ts'
import { registerTools } from './register-tools.ts'
import { asMcpToolServer } from './mcp-registration-agent.ts'
import { createKodyMcpServer } from './sentry-mcp-server.ts'
import { runWithInboundRequestSignal } from './inbound-request-signal.ts'

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
	onboardingNoticeConversationIds?: Array<string>
	onboardingNoticeLastShownAtMs?: number
	rawFetchHostNudges?: import('./raw-fetch-host-nudge.ts').RawFetchHostNudgeState
}
export type Props = McpServerProps

/** Owner-bound session handles map directly to an AgentCore runtime session. */
export function mcpRuntimeSessionId(userId: string, sessionId: string) {
	return createHmac('sha256', userId).update(sessionId).digest('hex')
}
function signature(env: Env, userId: string, id: string) {
	return createHmac('sha256', env.COOKIE_SECRET)
		.update(`${userId}:${id}`)
		.digest('hex')
}
function validSession(env: Env, userId: string, value: string) {
	const [id, mac] = value.split('.')
	if (!id || !mac || !/^[a-f0-9]{64}$/.test(mac)) return false
	return timingSafeEqual(
		Buffer.from(mac, 'hex'),
		Buffer.from(signature(env, userId, id), 'hex'),
	)
}

/** A fresh SDK server per request, with no Durable Object or global caller state. */
export async function fetchLegacyMcp(
	request: Request,
	env: Env,
	ctx: ExecutionContext<Props>,
): Promise<Response> {
	const caller = parseMcpCallerContext(ctx.props)
	const userId = caller.user?.userId
	if (!userId) return new Response('Unauthorized', { status: 401 })
	const sessionId = request.headers.get('Mcp-Session-Id')
	if (sessionId && !validSession(env, userId, sessionId))
		return new Response('Unknown MCP session', { status: 404 })
	if (request.method === 'DELETE') return new Response(null, { status: 200 })
	if (request.method !== 'POST') return new Response(null, { status: 405 })
	const parsed = (await request.clone().json()) as { method?: string }
	const initialized = parsed?.method === 'initialize'
	const instructions = initialized
		? await assembleMcpServerInstructionsForCaller({
				env,
				callerContext: caller,
			})
		: undefined
	const server = createKodyMcpServer({
		instructions,
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	})
	await registerTools({
		server: asMcpToolServer(server),
		getEnv: () => env,
		getCallerContext: () => caller,
		requireDomain: () => caller.baseUrl!,
		getLoopbackExports: () =>
			ctx.exports as unknown as import('#worker/front-door/host-context.ts').HostLoopbackExports,
		waitUntil: (promise) => ctx.waitUntil(promise),
	})
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	await server.connect(transport)
	const response = await runWithInboundRequestSignal(request.signal, () =>
		transport.handleRequest(request, { parsedBody: parsed }),
	)
	if (initialized) {
		const id = randomUUID()
		const handle = `${id}.${signature(env, userId, id)}`
		response.headers.set('Mcp-Session-Id', handle)
		response.headers.set(
			'X-Kody-Runtime-Session-Id',
			mcpRuntimeSessionId(userId, handle),
		)
	} else if (sessionId)
		response.headers.set(
			'X-Kody-Runtime-Session-Id',
			mcpRuntimeSessionId(userId, sessionId),
		)
	// JSON responses are complete; disconnect after the result is buffered.
	const body = await response.arrayBuffer()
	await server.close()
	return new Response(response.status === 204 ? null : body, {
		status: response.status,
		headers: response.headers,
	})
}
