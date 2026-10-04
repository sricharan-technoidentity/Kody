import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'

export type NodeFetch = (request: Request) => Promise<Response>

/** A Node transport for the existing Web Request/Response application. */
export async function startFrontDoorServer(input: {
	fetch: NodeFetch
	port?: number
	host?: string
}) {
	const server = createServer((incoming, outgoing) => {
		void serve(incoming, outgoing).catch((error: unknown) => {
			console.error('front-door-request-failed', error)
			if (!outgoing.headersSent) outgoing.writeHead(500)
			outgoing.end('Internal Server Error')
		})
	})
	async function serve(incoming: IncomingMessage, outgoing: ServerResponse) {
		const controller = new AbortController()
		incoming.on('aborted', () => controller.abort())
		outgoing.on('close', () => {
			if (!outgoing.writableFinished) controller.abort()
		})
		const headers = new Headers()
		for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
			headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!)
		}
		const method = incoming.method ?? 'GET'
		const request = new Request(
			`http://${headers.get('host')}${incoming.url}`,
			{
				method,
				redirect: 'manual',
				headers,
				signal: controller.signal,
				...(['GET', 'HEAD'].includes(method)
					? {}
					: {
							body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
							duplex: 'half',
						}),
			},
		)
		const response = await input.fetch(request)
		outgoing.statusCode = response.status
		for (const [key, value] of response.headers) {
			if (key !== 'set-cookie') outgoing.setHeader(key, value)
		}
		const cookies = response.headers.getSetCookie()
		if (cookies.length) outgoing.setHeader('Set-Cookie', cookies)
		if (method === 'HEAD' || !response.body) {
			await response.body?.cancel()
			outgoing.end()
			return
		}
		const reader = response.body.getReader()
		try {
			while (!controller.signal.aborted) {
				const { done, value } = await reader.read()
				if (done) break
				if (!outgoing.write(value))
					await once(outgoing, 'drain', { signal: controller.signal })
			}
		} finally {
			await reader.cancel()
			outgoing.end()
		}
	}
	server.listen(input.port ?? 0, input.host ?? '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string')
		throw new Error('Missing server address.')
	return {
		origin: `http://${input.host ?? '127.0.0.1'}:${address.port}`,
		async [Symbol.asyncDispose]() {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		},
	}
}
