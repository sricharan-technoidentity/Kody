import { createCapabilityBroker } from './capability-broker.ts'
import { verifyRunToken } from '#worker/runner/run-token.ts'

/** Trusted host dispatchers exist only for the life of their sandbox run. */
export function createBrokerHandler(input: { signingKey: string }) {
	const runs = new Map<
		string,
		{
			userId: string
			dispatch(capability: string, args: unknown): Promise<string>
		}
	>()
	const invoke = createCapabilityBroker({
		signingKey: input.signingKey,
		async dispatch(claims, capability, args) {
			const run = runs.get(claims.runId)
			if (!run || run.userId !== claims.userId)
				throw new Error('Unknown broker run owner.')
			return run.dispatch(capability, args)
		},
	})
	return {
		register(run: {
			runId: string
			userId: string
			dispatch(capability: string, args: unknown): Promise<string>
		}) {
			if (!run.userId || !run.runId || runs.has(run.runId))
				throw new Error('Invalid or duplicate broker run.')
			// ponytail: callbacks live in memory; a host restart fails the run rather than replaying uncertain side effects.
			runs.set(run.runId, run)
			return () => {
				runs.delete(run.runId)
			}
		},
		async fetch(request: Request) {
			if (request.method !== 'POST')
				return new Response('Method not allowed', { status: 405 })
			if (new URL(request.url).pathname === '/authorize') {
				try {
					const claims = await verifyRunToken(
						input.signingKey,
						request.headers.get('x-kody-run-token') ?? '',
					)
					if (runs.get(claims.runId)?.userId !== claims.userId)
						throw new Error('Unknown run')
					return Response.json({ userId: claims.userId, runId: claims.runId })
				} catch {
					return new Response('Unauthorized', { status: 401 })
				}
			}
			const body = await request.text()
			if (Buffer.byteLength(body) > 1024 * 1024)
				return new Response('Payload too large', { status: 413 })
			let parsed: unknown
			try {
				parsed = JSON.parse(body)
			} catch {
				return new Response('Invalid JSON', { status: 400 })
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				return new Response('Invalid request', { status: 400 })
			const { capability, arguments: args } = parsed as {
				capability?: unknown
				arguments?: unknown
			}
			if (typeof capability !== 'string')
				return new Response('Invalid capability', { status: 400 })
			try {
				const result = await invoke({
					runToken: request.headers.get('x-kody-run-token') ?? '',
					capability,
					arguments: args,
				})
				return new Response(result as string, {
					headers: { 'content-type': 'application/json' },
				})
			} catch (error) {
				if (
					error instanceof Error &&
					error.name === 'RetrieverCapabilityDenied'
				)
					return Response.json({ error: error.message }, { status: 403 })
				return Response.json(
					{ error: 'Capability broker rejected the request.' },
					{ status: 401 },
				)
			}
		},
	}
}
