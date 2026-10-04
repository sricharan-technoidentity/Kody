import { AsyncLocalStorage } from 'node:async_hooks'

const background = new AsyncLocalStorage<(promise: Promise<unknown>) => void>()
export function runWithHostContext<T>(
	sink: (promise: Promise<unknown>) => void,
	run: () => T,
): T {
	return background.run(sink, run)
}
export function waitUntil(promise: Promise<unknown>): void {
	const sink = background.getStore()
	if (sink) sink(promise)
	else
		void promise.catch((error: unknown) =>
			console.warn('background-work-failed', error),
		)
}

/** Plain host-side bridge; sandbox entrypoints still run inside workerd. */
export class WorkerEntrypoint<E = unknown, P = unknown> {
	protected ctx: ExecutionContext<P>
	protected env: E
	constructor(ctx: ExecutionContext<P>, env: E) {
		this.ctx = ctx
		this.env = env
	}
}
export const tracing = {
	enterSpan<T, A extends Array<unknown>>(
		_name: string,
		callback: (
			span: {
				isTraced: boolean
				setAttribute(key: string, value?: boolean | number | string): void
				end(): void
			},
			...args: A
		) => T,
		...args: A
	): T {
		return callback({ isTraced: false, setAttribute() {}, end() {} }, ...args)
	},
}
export type HostLoopbackExports = {
	KodyFetchGateway(input: {
		props: import('#worker/egress/proxy.ts').FetchGatewayProps
	}): Fetcher
	PackageAppRuntimeBridge?: (...args: unknown[]) => unknown
}
export const exports: HostLoopbackExports = {
	KodyFetchGateway() {
		throw new Error('Direct gateway unavailable; use the Runner broker.')
	},
}

export class RpcTarget {}
export class DurableObject {}
