import * as Sentry from '#worker/front-door/telemetry.ts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const serverImplementation = {
	name: 'kody-mcp',
	version: '1.0.0',
} as const

export function createKodyMcpServer(
	options: ConstructorParameters<typeof McpServer>[1],
): McpServer {
	return Sentry.wrapMcpServerWithSentry(
		new McpServer(serverImplementation, options),
		{
			recordInputs: false,
			recordOutputs: false,
		},
	)
}
