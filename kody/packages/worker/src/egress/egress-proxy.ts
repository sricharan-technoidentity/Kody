import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { type AwsEnv } from '#worker/aws/env.ts'
import { verifyRunToken } from '#worker/runner/run-token.ts'
import { expandSecretPlaceholders, type FetchGatewayProps } from './proxy.ts'

import { blocked, pinnedFetch } from './public-fetch.ts'
type Address = { address: string; family: number }

export async function egressFetch(input: {
	env: AwsEnv
	runToken: string
	url: string
	requiredHosts: Array<string>
	allowlist: Array<string>
	request?: Request
	context?: FetchGatewayProps
	resolve?: (hostname: string) => Promise<Array<Address>>
	connect?: (request: Request, addresses: Array<Address>) => Promise<Response>
}): Promise<Response> {
	const claims = await verifyRunToken(
		input.env.RUN_TOKEN_SIGNING_KEY,
		input.runToken,
		{ userId: input.env.userId },
	)
	if (claims.retriever || input.context?.allowOutboundFetch === false)
		throw new Error('Outbound fetch is unavailable in a retriever run.')
	async function check(url: string) {
		const parsed = new URL(url)
		const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
		if (
			!['https:', 'http:'].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			host === 'localhost' ||
			host ===
				new URL(
					input.context?.baseUrl ?? 'https://kody.codes',
				).hostname.toLowerCase() ||
			['kody.codes', 'kody.run'].some(
				(domain) => host === domain || host.endsWith(`.${domain}`),
			) ||
			!input.allowlist.includes(host) ||
			!input.requiredHosts.includes(host)
		)
			throw new Error('Outbound host is not allowed.')
		const addresses = isIP(host)
			? [{ address: host, family: isIP(host) }]
			: await (input.resolve ?? ((name) => lookup(name, { all: true })))(host)
		if (
			addresses.length === 0 ||
			addresses.some(
				(item) =>
					!isIP(item.address) ||
					blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4'),
			)
		)
			throw new Error('Outbound host resolves to a blocked address.')
		return addresses
	}
	await check(input.url)
	try {
		input.env.kv.update(
			`${claims.userId}:meters`,
			'outbound_fetches_per_day',
			(item) => ({ ...item!, remaining: Number(item!.remaining) - 1 }),
			(item) => Number(item?.remaining ?? 0) > 0,
		)
	} catch {
		throw new Error('Outbound fetch entitlement exhausted.')
	}
	const stamp = claims.provenance[0]!
	const original = input.request ?? new Request(input.url)
	const transformed = await expandSecretPlaceholders({
		request: original,
		props: {
			...input.context,
			baseUrl: input.context?.baseUrl ?? 'https://kody.codes',
			userId: claims.userId,
			email: input.context?.email ?? null,
			storageContext: input.context?.storageContext ?? {
				sessionId: null,
				appId: null,
				packageId: stamp.packageId,
				storageId: stamp.storageId,
			},
			grantedSecretAuthorityPackageIds: claims.provenance.flatMap((stamp) =>
				stamp.packageId ? [stamp.packageId] : [],
			),
		},
		env: {
			APP_DB: input.env.APP_DB as unknown as Env['APP_DB'],
			SECRET_KMS: input.env.kms,
		},
		resolveIntegrationToken: async (userId, name) =>
			input.env.vault.fetch(
				userId,
				name,
				input.env.AGENTCORE_IDENTITY_WORKLOAD,
			),
	})
	const addresses = await check(transformed.url)
	const headers = new Headers(transformed.headers)
	for (const header of [
		'x-kody-run-token',
		'x-kody-outbound-proto',
		'host',
		'connection',
		'proxy-authorization',
	])
		headers.delete(header)
	const request = new Request(transformed, {
		headers,
		redirect: 'manual',
		signal: AbortSignal.any([transformed.signal, AbortSignal.timeout(60000)]),
	})
	return (input.connect ?? pinnedFetch)(request, addresses)
}

/** The private Runner transport registers provenance before allowing any outbound call. */
export function createEgressHandler(input: {
	signingKey: string
	forUser(userId: string): AwsEnv | Promise<AwsEnv>
	resolve?: Parameters<typeof egressFetch>[0]['resolve']
	connect?: Parameters<typeof egressFetch>[0]['connect']
}) {
	const runs = new Map<string, { userId: string; context: FetchGatewayProps }>()
	return {
		register(run: {
			runId: string
			userId: string
			context: FetchGatewayProps
		}) {
			if (
				!run.runId ||
				!run.userId ||
				run.context.userId !== run.userId ||
				runs.has(run.runId)
			)
				throw new Error('Invalid or duplicate egress run.')
			runs.set(run.runId, run)
			return () => {
				runs.delete(run.runId)
			}
		},
		async fetch(request: Request) {
			try {
				const runToken = request.headers.get('x-kody-run-token') ?? ''
				const claims = await verifyRunToken(input.signingKey, runToken)
				const run = runs.get(claims.runId)
				if (!run || run.userId !== claims.userId)
					throw new Error('Unknown egress run owner.')
				const url = new URL(request.url)
				const protocol = request.headers.get('x-kody-outbound-proto')
				if (protocol) {
					if (!['http', 'https'].includes(protocol))
						throw new Error('Invalid outbound protocol.')
					url.protocol = protocol + ':'
				}
				const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
				// Raw fetch keeps its existing public-internet surface; secret host approvals remain in placeholder resolution.
				return await egressFetch({
					env: await input.forUser(claims.userId),
					runToken,
					url: url.href,
					request: new Request(url, request),
					context: run.context,
					requiredHosts: [host],
					allowlist: [host],
					resolve: input.resolve,
					connect: input.connect,
				})
			} catch {
				return new Response('Egress proxy rejected the request.', {
					status: 403,
				})
			}
		},
	}
}
