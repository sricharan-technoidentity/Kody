import { randomUUID } from 'node:crypto'
import { startLocalPoc } from './demo/bootstrap.ts'
import { writeE2ePocState } from './e2e-poc-state.ts'
import { isExecutedDirectly } from './node-runtime.ts'

async function startE2eWebServer() {
	const args = process.argv.slice(2)
	const portIndex = args.indexOf('--port')
	const port = portIndex < 0 ? 3847 : Number(args[portIndex + 1])
	const token = randomUUID()
	let env: Awaited<ReturnType<typeof startLocalPoc>>['env']
	const runtime = await startLocalPoc({
		port,
		async beforeServe(created) {
			env = created
			await env.seedUser({
				email: 'jane@example.com',
				username: 'jane',
				password: 'ilikecode',
			})
			await env.seedUser({
				email: 'kody@example.com',
				username: 'kody',
				password: 'ilikecode',
				admin: true,
			})
		},
		async control(request) {
			const url = new URL(request.url)
			if (url.pathname.startsWith('/__poc/')) {
				if (request.headers.get('Authorization') !== `Bearer ${token}`)
					return new Response(null, { status: 403 })
				if (url.pathname === '/__poc/messages')
					return Response.json({
						count: env.outbox.length,
						messages: env.outbox.map((mail) => ({
							...mail,
							from_email: mail.from,
							to_json: JSON.stringify(mail.to),
						})),
					})
				const body = (await request.json()) as {
					sql?: string
					user?: Parameters<typeof env.seedUser>[0]
				}
				if (url.pathname === '/__poc/seed' && body.user)
					await env.seedUser(body.user)
				else if (url.pathname === '/__poc/sql' && body.sql)
					await env.pg.exec(body.sql)
				else return new Response(null, { status: 404 })
				return Response.json({ ok: true })
			}
			return undefined
		},
	})
	await writeE2ePocState({ origin: runtime.origin, token })
	console.info(`Node POC front door: ${runtime.origin}`)
	let closing = false
	async function close() {
		if (closing) return
		closing = true
		await runtime.close()
		process.exit(0)
	}
	process.once('SIGINT', () => void close())
	process.once('SIGTERM', () => void close())
}
if (isExecutedDirectly(import.meta.url))
	void startE2eWebServer().catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
