import { initializeMailboxSchema } from '#worker/email/mailbox-schema.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test as vitestTest } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestObjectBucket } from '#worker/test-support/aws/fake-s3.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	createMailboxContext,
	type MailboxContext,
} from '#worker/email/mailbox-sql.ts'
import {
	createMailboxService,
	MailboxService,
} from '#worker/email/mailbox-service.ts'
const storage = new AsyncLocalStorage<{
	env: Env
	database: Awaited<ReturnType<typeof createTestDb>>
}>()
function current() {
	const fixture = storage.getStore()
	if (!fixture) throw new Error('Mail fixture must be used inside test.')
	return fixture
}
export const env = new Proxy({} as Env, {
	get: (_target, key) => Reflect.get(current().env, key),
	set: (_target, key, value) => Reflect.set(current().env, key, value),
	deleteProperty: (_target, key) => Reflect.deleteProperty(current().env, key),
	ownKeys: () => Reflect.ownKeys(current().env),
	getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
})
export const test: typeof vitestTest = ((
	name: string,
	optionsOrRun: unknown,
	maybeRun?: unknown,
) => {
	const run = (
		typeof optionsOrRun === 'function' ? optionsOrRun : maybeRun
	) as (...args: unknown[]) => unknown
	const options =
		typeof optionsOrRun === 'function'
			? typeof maybeRun === 'number'
				? { timeout: maybeRun }
				: {}
			: optionsOrRun
	return vitestTest(name, options as object, async (context) => {
		const database = await createTestDb()
		const meter = createInMemoryUserMeterEnv()
		// Legacy graph behavior fixtures need an operator writer; mailbox rows still use owner-scoped kody_writer.
		await database.pg.exec(
			'GRANT ALL ON ALL TABLES IN SCHEMA public TO kody_admin; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kody_admin; ALTER ROLE kody_admin BYPASSRLS; DROP TABLE IF EXISTS public.email_delivery_events, public.email_attachments, public.email_messages, public.email_threads CASCADE',
		)
		const fixtureEnv = {
			...process.env,
			...meter.env,
			APP_DB: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
			APP_DB_FOR_USER: (id: string) => database.forUser(id).db,
			EMAIL_BLOBS: createTestObjectBucket().bucket,
			BUNDLE_ARTIFACTS_KV: createMemoryKvNamespace().kv,
			APP_BASE_URL: 'https://kody.example.com',
			USER_EMAIL_DOMAIN: 'inbox.kody.example.com',
			SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
		} as unknown as Env
		fixtureEnv.SES_MAIL = {
			async send(mail) {
				const response = await fetch('https://ses.test/send', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(mail),
				})
				const result = (await response.json()) as {
					success?: boolean
					result?: { message_id?: string }
					errors?: unknown[]
				}
				if (!response.ok || !result.success || !result.result?.message_id)
					throw new Error(
						(result.errors?.[0] as { message?: string })?.message ??
							`SES mock send failed: ${JSON.stringify(result)}`,
					)
				return { messageId: result.result.message_id }
			},
		}
		fixtureEnv.MAILBOX_STORE = createMailboxService({
			forUser: (id) => database.forUser(id).db,
			env: fixtureEnv,
		})
		try {
			return await storage.run({ env: fixtureEnv, database }, () =>
				run(context),
			)
		} finally {
			await database.pg.close()
		}
	})
}) as typeof vitestTest
export function stubFor(ownerId: string) {
	return ownerId
}
export function rpcFor(userId: string) {
	return current().env.MAILBOX_STORE!.forUser(userId)
}
export function uniqueUserId(label: string) {
	return `mailbox-${label}-${crypto.randomUUID()}`
}
export function mailboxEnv() {
	return { MAILBOX_STORE: current().env.MAILBOX_STORE! }
}
export async function runMailbox<T>(
	ownerId: string,
	run: (instance: MailboxService, state: MailboxContext) => Promise<T>,
): Promise<T> {
	const fixture = current()
	const db = fixture.database.forUser(ownerId).db
	await db
		.prepare(
			`INSERT INTO kody_mailbox.mailbox_owner_identity(singleton,owner_id) VALUES (1,?) ON CONFLICT(user_id,singleton) DO NOTHING`,
		)
		.bind(ownerId)
		.run()
	const state = createMailboxContext(db)
	await initializeMailboxSchema(state.storage)
	return run(
		fixture.env.MAILBOX_STORE!.forUser(ownerId) as unknown as MailboxService,
		state,
	)
}

export function seedDailyEmailSendCounter(userId: string, count: number) {
	return current()
		.env.USER_METERS!.forUser(userId)
		.initialize({
			resource: 'email_sends_per_day',
			day: new Date().toISOString().slice(0, 10),
			count,
			updatedAt: new Date().toISOString(),
		})
}

export function runMailTestSql(sql: string) {
	return current().database.pg.exec(sql)
}
