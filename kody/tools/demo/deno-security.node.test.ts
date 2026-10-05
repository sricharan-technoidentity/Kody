import { expect, test } from 'vitest'
import { createExecutorModuleSource } from '#mcp/executor.ts'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { createEgressHandler } from '#worker/egress/egress-proxy.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { createTargetTestEnv } from '#worker/test-support/aws/target-test-env.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { invokeCapability } from '#worker/broker/capability-broker.ts'
import { invokeDenoSpike } from './deno-spike.ts'

test(
	'Deno uses the real broker and SQLite authority, rejects another owner/expired tokens and blocks metadata/retriever egress',
	{ timeout: 60000 },
	async () => {
		const { env, close } = await createTargetTestEnv({ userId: 'alice' })
		const stack = new AsyncDisposableStack()
		stack.defer(close)
		try {
			const signingKey = env.RUN_TOKEN_SIGNING_KEY
			const broker = createBrokerHandler({ signingKey })
			const egress = createEgressHandler({
				signingKey,
				forUser: () => env,
				connect: async () => {
					throw new Error('A denied request must never connect.')
				},
			})
			const brokerServer = stack.use(
				await startFrontDoorServer({ fetch: broker.fetch }),
			)
			const egressServer = stack.use(
				await startFrontDoorServer({ fetch: egress.fetch }),
			)
			const claims = {
				userId: 'alice',
				runId: 'deno-authority',
				expiresAt: Date.now() + 60000,
				retriever: false,
				provenance: [
					{
						moduleId: 'executor.js',
						packageId: 'notes',
						storageId: 'package:notes',
					},
				],
			}
			let runToken = await mintRunToken(signingKey, claims)
			env.kv.put({
				pk: 'alice:meters',
				sk: 'storage_bytes',
				remaining: 1024 * 1024,
			})
			const dispatched: Array<string> = []
			stack.defer(
				broker.register({
					userId: 'alice',
					runId: claims.runId,
					async dispatch(capability, args) {
						dispatched.push(capability)
						if (capability !== 'kody.storageSql')
							throw new Error('Unknown capability.')
						return JSON.stringify({
							result: await invokeCapability({
								env,
								runToken,
								capability: 'storage.sql',
								arguments: args,
							}),
						})
					},
				}),
			)
			stack.defer(
				egress.register({
					userId: 'alice',
					runId: claims.runId,
					context: {
						baseUrl: 'https://kody.dev',
						userId: 'alice',
						email: null,
						storageContext: {
							packageId: 'notes',
							storageId: 'package:notes',
							sessionId: null,
							appId: null,
						},
					},
				}),
			)
			const invoke = (code: string) =>
				invokeDenoSpike({
					graph: {
						mainModule: 'executor.js',
						compatibilityDate: '2026-04-16',
						compatibilityFlags: ['nodejs_compat'],
						providers: ['kody'],
						runtimeMethods: {},
						modules: {
							'executor.js': createExecutorModuleSource({
								code: `async () => {const kody = __kodyProvider; return (${code})()}`,
								providers: [{ name: 'kody', fns: {} }],
								shadowGlobalThis: false,
								timeoutMs: 2000,
							}),
						},
					},
					runToken,
					brokerUrl: brokerServer.origin,
					egressUrl: egressServer.origin,
				})
			const query = `async () => kody.storageSql({sql:'SELECT number FROM evidence',userId:'bob',storageId:'package:bob'})`
			expect(
				await invoke(
					`async () => { await kody.storageSql({sql:'CREATE TABLE evidence(number INTEGER)'}); await kody.storageSql({sql:'INSERT INTO evidence VALUES (7)'}); return await kody.storageSql({sql:'SELECT number FROM evidence',userId:'bob',storageId:'package:bob'}); }`,
				),
			).toMatchObject({ result: [[7]] })
			const cell = env.STORAGE_CELLS.forBucket({
				userId: 'alice',
				storageId: 'package:notes',
			})
			expect(
				(
					await cell.sqlQuery({
						query: 'SELECT number FROM evidence',
						writable: false,
					})
				).rows,
			).toEqual([{ number: 7 }])
			runToken = await mintRunToken(signingKey, { ...claims, userId: 'bob' })
			expect(await invoke(query)).toMatchObject({
				error: 'Capability broker rejected the request.',
			})
			runToken = await mintRunToken(signingKey, {
				...claims,
				expiresAt: Date.now() - 1,
			})
			expect(await invoke(query)).toMatchObject({
				error: 'Capability broker rejected the request.',
			})
			runToken = await mintRunToken(signingKey, { ...claims, retriever: true })
			expect(
				await invoke(`async () => kody.storageSet({key:'unsafe',value:1})`),
			).toMatchObject({ error: expect.stringContaining('read-only') })
			expect(
				await invoke(
					`async () => (await fetch('https://api.example.com/data')).status`,
				),
			).toMatchObject({ result: 403 })
			runToken = await mintRunToken(signingKey, claims)
			expect(
				await invoke(
					`async () => (await fetch('http://169.254.169.254/latest/meta-data', {headers:{'x-kody-run-token':'forged'}})).status`,
				),
			).toMatchObject({ result: 403 })
			for (const url of [
				'http://169.254.170.2/credentials',
				'http://127.0.0.1:8080/ping',
				'http://[::1]:8080/ping',
			])
				expect(
					await invoke(
						`async () => (await fetch(${JSON.stringify(url)})).status`,
					),
				).toMatchObject({ result: 403 })
			expect(dispatched).toEqual(Array(3).fill('kody.storageSql'))
		} finally {
			await stack.disposeAsync()
		}
	},
)
