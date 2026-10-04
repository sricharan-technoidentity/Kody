import { WorkerEntrypoint } from '#worker/front-door/host-context.ts'
import {
	executeGatewayFetch,
	type FetchGatewayProps,
} from '#worker/egress/proxy.ts'
export * from '#worker/egress/proxy.ts'

export class KodyFetchGateway extends WorkerEntrypoint<Env, FetchGatewayProps> {
	async fetch(request: Request) {
		return executeGatewayFetch({
			env: this.env,
			props: this.ctx.props,
			request,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			timeoutMs: this.ctx.props.outboundFetchTimeoutMs,
		})
	}
}
