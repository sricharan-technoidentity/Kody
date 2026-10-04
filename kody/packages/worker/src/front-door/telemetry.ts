import * as Sentry from '@sentry/node'
export * from '@sentry/node'
export type NodeOptions = Sentry.NodeOptions

export function withSentry<T>(
	options: (env: Env) => Sentry.NodeOptions | undefined,
	handler: T,
): T {
	// ponytail: collector initialization belongs to the Node service launcher; POC keeps existing capture calls.
	void options
	return handler
}
export function wrapMcpServerWithSentry<T>(server: T, _options?: unknown): T {
	return server
}
