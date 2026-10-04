import { runMailTestSql } from '#worker/test-support/mail.ts'
import { env } from '#worker/test-support/mail.ts'
import { expect } from 'vitest'
import { test } from '#worker/test-support/mail.ts'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('classification requires the sender-rules schema', async () => {
	await runMailTestSql(`DROP TABLE email_sender_rules`)

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId: 'classification-user',
			envelopeFrom: 'sender@example.test',
			authResults: 'dmarc=fail',
		}),
	).rejects.toThrow(/relation.*email_sender_rules.*does not exist/)
})
