import { createHmac, timingSafeEqual } from 'node:crypto'
const stickyCookie = 'kody_read_after_write'
function cookieValue(cookies: string | null, name: string) {
	return (
		cookies
			?.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${name}=`))
			?.slice(name.length + 1) ?? ''
	)
}
function signature(secret: string, session: string, expires: string) {
	return createHmac('sha256', secret)
		.update(`${session}:${expires}`)
		.digest('hex')
}
export function usesWriterAfterMutation(
	request: Request,
	secret: string,
	now = Date.now(),
) {
	const [expires, mac] = cookieValue(
		request.headers.get('Cookie'),
		stickyCookie,
	).split('.')
	const session = cookieValue(request.headers.get('Cookie'), 'kody_session')
	if (
		!session ||
		!expires ||
		!mac ||
		!/^[a-f0-9]{64}$/.test(mac) ||
		Number(expires) < now ||
		Number(expires) > now + 10000
	)
		return false
	return timingSafeEqual(
		Buffer.from(mac, 'hex'),
		Buffer.from(signature(secret, session, expires), 'hex'),
	)
}
export function setWriterAfterMutation(
	response: Response,
	request: Request,
	secret: string,
	now = Date.now(),
) {
	const newSession = response.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith('kody_session='))
	const session = cookieValue(
		newSession ?? request.headers.get('Cookie'),
		'kody_session',
	)
	if (!session) return
	const expires = String(now + 5000)
	response.headers.append(
		'Set-Cookie',
		`${stickyCookie}=${expires}.${signature(secret, session, expires)}; Max-Age=5; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
	)
}
