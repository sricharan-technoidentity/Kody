import { randomUUID } from 'node:crypto'
import getPort from 'get-port'
import { type Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { createFrontDoorTestEnv } from '#worker/test-support/front-door.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import originHandler from '#worker/index.ts'
import {
	authorizeOAuthClient,
	closeMcpConnection,
	connectMcpClient,
	connectStatelessMcpClient,
	exchangeAuthorizationCode,
	loginToApp,
	registerOAuthClient,
	type AppAuthUser,
} from './mcp-oauth-client.ts'

type TestUser = AppAuthUser
type TestCallToolParams = CallToolRequest['params'] & {
	headers?: Record<string, string>
}
type ConnectedTestClient = {
	callTool(params: TestCallToolParams): ReturnType<Client['callTool']>
	listTools(): ReturnType<Client['listTools']>
}
const environments = new Map<
	string,
	Awaited<ReturnType<typeof createFrontDoorTestEnv>>
>()

export async function createTestDatabase() {
	const persistDir = randomUUID()
	return {
		persistDir,
		user: {
			email: 'kody@example.com',
			username: 'mcp-test-user',
			password: 'ilikecode',
		} satisfies TestUser,
		async [Symbol.asyncDispose]() {
			environments.delete(persistDir)
		},
	}
}
export async function startDevServer(
	persistDir: string,
	_options?: { withCloudflareMock?: boolean },
) {
	const port = await getPort({ host: '127.0.0.1' })
	const origin = `http://127.0.0.1:${port}`
	const env = await createFrontDoorTestEnv({ handler: originHandler, origin })
	try {
		const server = await startFrontDoorServer({ fetch: env.fetch, port })
		environments.set(persistDir, env)
		return {
			origin,
			markEmailVerified: (email: string) =>
				markEmailVerifiedInMcpTestDatabase({ persistDir, email }),
			async [Symbol.asyncDispose]() {
				try {
					await server[Symbol.asyncDispose]()
				} finally {
					environments.delete(persistDir)
					await env.close()
				}
			},
		}
	} catch (error) {
		await env.close()
		throw error
	}
}
function environment(id: string) {
	const env = environments.get(id)
	if (!env) throw new Error('No Node test environment for this server')
	return env
}
export async function markEmailVerifiedInMcpTestDatabase(input: {
	persistDir: string
	email: string
}) {
	await environment(input.persistDir).pg.query(
		'UPDATE users SET email_verified_at = $1 WHERE email = $2',
		[new Date().toISOString(), input.email],
	)
}
export async function assignRoleInMcpTestDatabase(input: {
	persistDir: string
	email: string
	role: string
}) {
	await environment(input.persistDir).pg.query(
		`INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = $2 ON CONFLICT DO NOTHING`,
		[input.email, input.role],
	)
}

/**
 * Browser session cookie for authenticated app-origin fetches
 * (`Cookie: kody_session=…`). Same JSON `/auth` signup-or-login path used by
 * MCP OAuth setup; safe to call again after `createMcpClient`.
 */
export async function createAppSessionCookie(origin: string, user: TestUser) {
	return loginToApp(origin, user)
}

export async function createMcpClient(
	origin: string,
	user: TestUser,
	options: {
		// `/mcp` rejects unverified accounts, so the test user's email is
		// marked verified in the local PGlite database before connecting.
		persistDir: string
		extraHeaders?: Record<string, string>
		markEmailVerified?: (email: string) => Promise<void>
	},
) {
	const extraHeaders = options.extraHeaders
	const cookieHeader = await loginToApp(origin, user)
	if (options.markEmailVerified) {
		await options.markEmailVerified(user.email)
	} else {
		await markEmailVerifiedInMcpTestDatabase({
			persistDir: options.persistDir,
			email: user.email,
		})
	}
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const defaultHeaders: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
	}

	const defaultConnection = await connectMcpClient(origin, {
		...defaultHeaders,
		...extraHeaders,
	})

	const client: ConnectedTestClient = {
		listTools() {
			return defaultConnection.client.listTools()
		},
		async callTool(params) {
			const { headers, ...callToolParams } = params
			if (!headers || Object.keys(headers).length === 0) {
				return defaultConnection.client.callTool(callToolParams)
			}

			const overrideConnection = await connectMcpClient(origin, {
				...defaultHeaders,
				...extraHeaders,
				...headers,
			})
			try {
				return await overrideConnection.client.callTool(callToolParams)
			} finally {
				await closeMcpConnection(overrideConnection)
			}
		},
	}

	return {
		client,
		async [Symbol.asyncDispose]() {
			await closeMcpConnection(defaultConnection)
		},
	}
}

/**
 * Modern-era MCP client (protocol revision 2026-07-28) from the SDK v2
 * client package, pinned so the connection fails loudly unless the server
 * serves the stateless lane. Reuses the same signup + OAuth plumbing as
 * `createMcpClient`.
 */
export async function createModernMcpClient(
	origin: string,
	user: TestUser,
	options: {
		persistDir: string
	},
) {
	const cookieHeader = await loginToApp(origin, user)
	await markEmailVerifiedInMcpTestDatabase({
		persistDir: options.persistDir,
		email: user.email,
	})
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const connection = await connectStatelessMcpClient(
		origin,
		{ Authorization: `Bearer ${accessToken}` },
		{ name: 'kody-mcp-e2e-modern-client' },
	)
	return {
		client: connection.client,
		async [Symbol.asyncDispose]() {
			await connection.client.close().catch(() => undefined)
			await connection.transport.close().catch(() => undefined)
		},
	}
}
