import { expect, test } from 'vitest'
import { startFrontDoorServer } from './server.ts'

test('Node transport preserves binary bodies, redirects, repeated cookies and HEAD', async () => {
	await using server = await startFrontDoorServer({
		async fetch(request) {
			expect(request.redirect).toBe('manual')
			if (new URL(request.url).pathname === '/redirect') {
				const headers = new Headers({ Location: '/done' })
				headers.append('Set-Cookie', 'one=1; Path=/')
				headers.append('Set-Cookie', 'two=2; Path=/')
				return new Response(null, { status: 303, headers })
			}
			return new Response(
				request.method === 'HEAD' ? null : await request.arrayBuffer(),
				{
					headers: { 'Content-Type': 'application/octet-stream' },
				},
			)
		},
	})
	const bytes = new Uint8Array([0, 255, 10, 128])
	const echoed = await fetch(server.origin, { method: 'POST', body: bytes })
	expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(bytes)
	const redirect = await fetch(`${server.origin}/redirect`, {
		redirect: 'manual',
	})
	expect(redirect.status).toBe(303)
	expect(redirect.headers.getSetCookie()).toEqual([
		'one=1; Path=/',
		'two=2; Path=/',
	])
	expect(await (await fetch(server.origin, { method: 'HEAD' })).text()).toBe('')
})
