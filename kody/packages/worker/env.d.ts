import { type RepoSessionRpc } from './src/repo/repo-session-rpc.ts'
import { type RepoSessionIndexRpc } from './src/repo/repo-session-catalog.ts'
import { type MailboxNamespace } from './src/email/mailbox-service.ts'
import { type createStorageCells } from './src/storage-cell/storage-cell.ts'
import { type AwsEnv } from './src/env-schema.ts'

declare global {
	interface Env extends AwsEnv {}

	interface Env {
		RUNNER_LOADER?: import('./src/runner/loader.ts').RunnerLoader
		RUNNER_BUNDLER?: {
			createWorker(
				input: import('./src/package-runtime/package-build-tools.ts').BundleOptions,
			): Promise<{
				mainModule: string
				modules: import('./src/worker-loader-types.ts').WorkerLoaderModules
			}>
		}
		REPO_SESSIONS?: (sessionId: string) => RepoSessionRpc
		REPO_SESSION_SERVICES?: (
			ownerId: string,
			sessionId: string,
		) => RepoSessionRpc | Promise<RepoSessionRpc>
		REPO_SESSION_CATALOG?: (ownerId: string) => RepoSessionIndexRpc
		MAILBOX_STORE?: MailboxNamespace
		SES_MAIL?: import('./src/email/ses.ts').SesMail
		MCP_CLIENTS?: import('./src/mcp-client/service.ts').McpClients
		REALTIME_SESSIONS?: import('./src/aws/dynamo-realtime-sessions.ts').RealtimeSessions
		STORAGE_CELLS?: ReturnType<typeof createStorageCells>
	}

	interface CustomExportedHandler<Props = {}> {
		fetch: (
			request: Request,
			env: Env,
			ctx: ExecutionContext<Props>,
		) => Response | Promise<Response>
	}
}

export {}

declare module '*.md' {
	const value: string
	export default value
}
declare module '*.wasm' {
	const value: WebAssembly.Module
	export default value
}
