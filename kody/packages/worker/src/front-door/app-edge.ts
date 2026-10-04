import { parsePackageAppRequestHost } from '#worker/app-base-url.ts'
import { handlePackageAppOriginRequest } from '#app/package-app-origin.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import {
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from '#worker/package-invocations/http.ts'

/** All package hostnames and published URL shapes keep the same Runner path. */
export function isAppEdgeRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	return (
		Boolean(parsePackageAppRequestHost({ env, url })) ||
		isPackageInvocationApiRequest(url.pathname) ||
		isPackageAppRequestPath(url.pathname)
	)
}
export async function fetchAppEdge(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
) {
	const response = await handlePackageAppOriginRequest(request, env)
	if (response) return response
	const path = new URL(request.url).pathname
	if (isPackageInvocationApiRequest(path))
		return handlePackageInvocationApiRequest(request, env, ctx)
	if (isPackageAppRequestPath(path))
		return handlePackageAppRequest(request, env)
	return new Response('Not Found', { status: 404 })
}
