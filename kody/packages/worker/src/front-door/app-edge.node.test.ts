import { expect, test } from 'vitest'
import { isAppEdgeRequest } from '#worker/front-door/app-edge.ts'

const packageAppOrigin = 'https://kodyapps.dev'

function request(url: string) {
	return new Request(url)
}

function env(input: { packageAppBaseUrl?: string } = {}) {
	return {
		PACKAGE_APP_BASE_URL: input.packageAppBaseUrl,
	} as Env
}

test('app edge requests include package-app apex, user subdomains, and app-origin package paths', () => {
	const production = env({ packageAppBaseUrl: packageAppOrigin })

	expect(isAppEdgeRequest(request(`${packageAppOrigin}/`), production)).toBe(
		true,
	)
	expect(
		isAppEdgeRequest(
			request('https://kentcdodds.kodyapps.dev/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isAppEdgeRequest(
			request(
				'https://kentcdodds.kodyapps.dev/packages/hn-pulse?__kody_handoff=token',
			),
			production,
		),
	).toBe(true)
	// Wildcard DNS still delivers nested/invalid labels; runtime owns the 404.
	expect(
		isAppEdgeRequest(
			request('https://a.b.kodyapps.dev/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isAppEdgeRequest(
			request('https://heykody.app/@kentcdodds/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isAppEdgeRequest(
			request(
				'https://heykody.app/@kentcdodds/api/package-invocations/demo/run',
			),
			production,
		),
	).toBe(true)

	expect(
		isAppEdgeRequest(request('https://heykody.app/account'), production),
	).toBe(false)
	expect(
		isAppEdgeRequest(request('https://heykody.app/login'), production),
	).toBe(false)
})
