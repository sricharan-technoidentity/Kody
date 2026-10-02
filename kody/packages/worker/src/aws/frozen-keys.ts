import { kvItemKey } from './dynamo-kv.ts'
import { type AwsEnv } from './env.ts'

export async function storeFrozenKey(input: {
	env: AwsEnv
	home: 'dynamo' | 's3' | 'postgres'
	key: string
	value: Uint8Array
}): Promise<void> {
	// Same key mappings as `dynamo-kv.ts` (KV key → partition key) and `s3-objects.ts` (R2 key → object key).
	if (input.home === 'dynamo') {
		input.env.kv.put({ ...kvItemKey(input.key), value: input.value })
		return
	}
	if (input.home === 's3') {
		input.env.objects.put(input.key, input.value)
		return
	}
	// Durable Object names and vector ids become PostgreSQL row keys verbatim; the P2 probe
	// table stands in for their tables, owned by the caller's RLS context.
	await input.env.db
		.prepare(
			`INSERT INTO isolation_probe (id, user_id, value)
			 VALUES (?, current_setting('app.user_id', true), ?)
			 ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
		)
		.bind(input.key, new TextDecoder().decode(input.value))
		.run()
}
