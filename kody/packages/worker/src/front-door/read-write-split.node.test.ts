import { expect, test, vi } from 'vitest'
import { createTargetTestEnv } from '../test-support/aws/target-test-env.ts'
import { createFrontDoor } from './handler.ts'
import { createAwsEnv } from './env.ts'
import { createPgDatabase } from '../aws/pg-database.ts'
import { usesWriterAfterMutation } from './read-write-split.ts'

test('front door uses an owner reader, sends forms through a real Temporal activity, and fences read-after-write to that session', async () => {
	const target = await createTargetTestEnv({ userId: 'alice' })
	const { env } = target
	const temporal = await target.createTemporalEnv({ kms: env.kms })
	try {
		await env.pg.query(
			"INSERT INTO isolation_probe VALUES ('a', 'alice', 'old'), ('b', 'bob', 'private')",
		)
		const reader = vi.spyOn(env.reader, 'prepare')
		const writer = vi.spyOn(env.db, 'prepare')
		const writerReader = createPgDatabase({
			connection: env.pg,
			role: 'kody_reader',
			userId: 'alice',
		})
		const stickyReader = vi.spyOn(writerReader, 'prepare')
		const base = {
			COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef',
			TEMPORAL: temporal.temporal,
			MCP_CLIENTS: {
				forUser(owner: string) {
					expect(owner).toBe('alice')
					return {
						async getSnapshot() {
							await env.db
								.prepare(
									"UPDATE isolation_probe SET value = 'snapshot' WHERE id = 'a'",
								)
								.run()
							return { servers: [] }
						},
					}
				},
			},
		} as Env
		const factory = createAwsEnv({
			bindings: base,
			databases: {
				forUser: (owner) =>
					owner === 'alice'
						? { db: env.db, reader: env.reader, writerReader }
						: env.forUser(owner),
				community: env.reader,
				admin: env.db,
				adminReader: env.reader,
				analytics: env.reader,
				indexer: env.db,
				subjectReader: (owner) => env.forUser(owner).reader,
				subjectPurger: (owner) => env.forUser(owner).db,
			},
		})
		// This harness selects a known principal to isolate the read/write behavior from cookie authentication.
		factory.forRequest = async (_request, write, sticky) =>
			factory.forUser('alice', write, sticky)
		const door = createFrontDoor({
			env: factory,
			temporal: temporal.temporal,
			handler: {
				async fetch(request, scoped) {
					if (new URL(request.url).searchParams.has('consume-token')) {
						await scoped.APP_DB.prepare(
							"UPDATE isolation_probe SET value = 'verified' WHERE id = 'a'",
						).run()
						return new Response(null, { status: 204 })
					}
					if (new URL(request.url).pathname === '/account/mcp') {
						expect(() => scoped.MCP_CLIENTS!.forUser('bob')).toThrow(
							'owner mismatch',
						)
						return Response.json(
							await scoped.MCP_CLIENTS!.forUser('alice').getSnapshot(),
						)
					}
					if (request.method === 'POST') {
						await scoped.APP_DB.prepare(
							"UPDATE isolation_probe SET value = ? WHERE id = 'a'",
						)
							.bind(await request.text())
							.run()
						return new Response(null, {
							status: 303,
							headers: {
								Location: '/account',
								'Set-Cookie': 'kody_session=alice; Path=/',
							},
						})
					}
					return Response.json(
						(
							await scoped.APP_DB.prepare(
								'SELECT value FROM isolation_probe',
							).all()
						).results,
					)
				},
			},
		})
		await temporal.startWorkers({ activities: door.activities })
		const get = new Request('https://kody.codes/account')
		expect(await (await door.fetch(get)).json()).toEqual([{ value: 'old' }])
		expect(reader).toHaveBeenCalled()
		expect(writer).not.toHaveBeenCalled()
		const changed = await door.fetch(
			new Request(get.url, { method: 'POST', body: 'Alice' }),
		)
		expect(changed.status).toBe(303)
		expect(writer).toHaveBeenCalled()
		const cookies = changed.headers
			.getSetCookie()
			.map((cookie) => cookie.split(';')[0])
			.join('; ')
		writer.mockClear()
		const sticky = new Request(get.url, { headers: { Cookie: cookies } })
		expect(usesWriterAfterMutation(sticky, base.COOKIE_SECRET)).toBe(true)
		expect(await (await door.fetch(sticky)).json()).toEqual([
			{ value: 'Alice' },
		])
		expect(stickyReader).toHaveBeenCalled()
		expect(writer).not.toHaveBeenCalled()
		await expect(
			writerReader.prepare("UPDATE isolation_probe SET value = 'bad'").run(),
		).rejects.toThrow(/read-only transaction/)
		expect(
			usesWriterAfterMutation(
				new Request(get.url, {
					headers: { Cookie: cookies.replace('alice', 'bob') },
				}),
				base.COOKIE_SECRET,
			),
		).toBe(false)
		writer.mockClear()
		expect(
			await (
				await door.fetch(new Request('https://kody.codes/account/mcp'))
			).json(),
		).toEqual({ servers: [] })
		expect(writer).toHaveBeenCalled()
		expect(
			await env.reader.prepare('SELECT value FROM isolation_probe').all(),
		).toMatchObject({ results: [{ value: 'snapshot' }] })
		// Verification/unsubscribe links and OAuth callbacks consume state even when opened with GET.
		for (const path of [
			'/verify-email-claim-release',
			'/verify-email-destination',
			'/unsubscribe/tips',
			'/auth/github/callback',
			'/account/mcp-servers/oauth/callback',
		]) {
			writer.mockClear()
			expect(
				(
					await door.fetch(
						new Request(`https://kody.codes${path}?consume-token=test`),
					)
				).status,
			).toBe(204)
			expect(writer).toHaveBeenCalled()
		}
		expect(
			usesWriterAfterMutation(sticky, base.COOKIE_SECRET, Date.now() + 10000),
		).toBe(false)
	} finally {
		await temporal.close()
		await target.close()
	}
})
