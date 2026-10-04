import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'

type Address = { address: string; family: number }
export const blocked = new BlockList()
for (const [address, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['192.0.2.0', 24],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const)
	blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
	['2001:db8::', 32],
	['2002::', 16],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
] as const)
	blocked.addSubnet(address, prefix, 'ipv6')

/** Connect to the already-checked DNS answers; never resolve the hostname again. */
export async function pinnedFetch(request: Request, addresses: Array<Address>) {
	const body = ['GET', 'HEAD'].includes(request.method)
		? undefined
		: Buffer.from(await request.arrayBuffer())
	const url = new URL(request.url)
	return new Promise<Response>((resolve, reject) => {
		const outbound = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
			url,
			{
				method: request.method,
				headers: Object.fromEntries(request.headers),
				signal: request.signal,
				lookup(_hostname, options, callback) {
					if (options.all) callback(null, addresses)
					else callback(null, addresses[0]!.address, addresses[0]!.family)
				},
			},
			(incoming) => {
				const headers = new Headers()
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value))
						for (const item of value) headers.append(name, item)
					else if (value !== undefined) headers.set(name, value)
				}
				const status = incoming.statusCode ?? 502
				const empty =
					request.method === 'HEAD' || [204, 205, 304].includes(status)
				if (empty) incoming.resume()
				resolve(
					new Response(
						empty
							? null
							: (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
						{ status, headers },
					),
				)
			},
		)
		outbound.on('error', reject)
		outbound.end(body)
	})
}

/** OAuth client metadata has no credentials and may only reach public HTTPS destinations. */
export async function publicMetadataFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init)
	const url = new URL(request.url)
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (url.protocol !== 'https:' || url.username || url.password)
		throw new Error('Client metadata requires public HTTPS.')
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: await lookup(host, { all: true })
	if (
		!addresses.length ||
		addresses.some((item) =>
			blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4'),
		)
	)
		throw new Error('Client metadata resolves to a private address.')
	// CIMD's provider handles redirects explicitly, so each destination is checked again.
	return pinnedFetch(request, addresses)
}
