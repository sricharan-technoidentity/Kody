// ponytail: mutation bodies are buffered in Temporal payloads; use object references/streaming for large uploads and responses.
export type HttpRequestPayload = {
	url: string
	method: string
	headers: Array<[string, string]>
	body: string | null
}
export type HttpResponsePayload = {
	status: number
	headers: Array<[string, string]>
	body: string | null
}

export async function encodeRequest(
	request: Request,
): Promise<HttpRequestPayload> {
	return {
		url: request.url,
		method: request.method,
		headers: [...request.headers],
		body: request.body
			? Buffer.from(await request.arrayBuffer()).toString('base64')
			: null,
	}
}
export function decodeRequest(request: HttpRequestPayload) {
	return new Request(request.url, {
		method: request.method,
		redirect: 'manual',
		headers: request.headers,
		body: request.body === null ? null : Buffer.from(request.body, 'base64'),
	})
}
export async function encodeResponse(
	response: Response,
): Promise<HttpResponsePayload> {
	const headers: Array<[string, string]> = [...response.headers].filter(
		([key]) => key !== 'set-cookie',
	)
	for (const cookie of response.headers.getSetCookie())
		headers.push(['Set-Cookie', cookie])
	return {
		status: response.status,
		headers,
		body: response.body
			? Buffer.from(await response.arrayBuffer()).toString('base64')
			: null,
	}
}
export function decodeResponse(response: HttpResponsePayload) {
	return new Response(
		response.body === null ? null : Buffer.from(response.body, 'base64'),
		{ status: response.status, headers: response.headers },
	)
}
