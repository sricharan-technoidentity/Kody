import { expect, test } from 'vitest'
import { createFakeKms } from '#worker/test-support/aws/fake-kms.ts'
import {
	decryptPlatformOauthClientSecret,
	decryptSecretValue,
	decryptUserOauthAccessToken,
	encryptSecretValue,
	encryptPlatformOauthClientSecret,
	encryptUserOauthAccessToken,
	encryptWebhookUrlSecret,
	decryptWebhookUrlSecret,
	platformOauthAppContext,
	userIntegrationCredentialContext,
	userSecretContext,
	userWebhookUrlSecretContext,
} from './crypto.ts'

test('secrets use KMS envelopes bound to { purpose, userId } and reject other keys or malformed payloads', async () => {
	const calls: Array<Record<string, string>> = []
	const kms = createFakeKms()
	const env = {
		SECRET_KMS: {
			encrypt: (value: Uint8Array, context: Record<string, string>) => {
				calls.push(context)
				return kms.encrypt(value, context)
			},
			decrypt: kms.decrypt,
		},
	}
	const context = userSecretContext('user-1')
	const encrypted = await encryptSecretValue(env, 'my-secret-value', context)
	expect(calls).toEqual([{ userId: 'user-1', purpose: 'mcp-secret-store' }])
	expect(encrypted).not.toContain('my-secret-value')
	expect(await decryptSecretValue(env, encrypted, context)).toBe(
		'my-secret-value',
	)
	await expect(
		decryptSecretValue({ SECRET_KMS: createFakeKms() }, encrypted, context),
	).rejects.toThrow('Unable to decrypt secret value.')
	await expect(decryptSecretValue(env, 'no-envelope', context)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)
	// A row copied to another owner fails the encryption context.
	await expect(
		decryptSecretValue(env, encrypted, userSecretContext('user-2')),
	).rejects.toThrow('Unable to decrypt secret value.')
	const tampered = encrypted.replace(/"data":"(.)/, (_match, first: string) =>
		first === 'A' ? '"data":"B' : '"data":"A',
	)
	await expect(decryptSecretValue(env, tampered, context)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)

	// Purposes never interchange, even for the same owner.
	const integration = userIntegrationCredentialContext('user-1', 'github')
	const token = await encryptUserOauthAccessToken(env, 'gho_token', integration)
	expect(await decryptUserOauthAccessToken(env, token, integration)).toBe(
		'gho_token',
	)
	await expect(decryptSecretValue(env, token, context)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)

	const platformEncrypted = await encryptPlatformOauthClientSecret(
		env,
		'client-secret-value',
		platformOauthAppContext('one'),
	)
	expect(
		await decryptPlatformOauthClientSecret(
			env,
			platformEncrypted,
			platformOauthAppContext('one'),
		),
	).toBe('client-secret-value')
	await expect(
		decryptPlatformOauthClientSecret(
			env,
			platformEncrypted,
			platformOauthAppContext('two'),
		),
	).rejects.toThrow('Unable to decrypt platform client secret.')

	const webhookContext = userWebhookUrlSecretContext('user-a', 'endpoint-1')
	const webhookEncrypted = await encryptWebhookUrlSecret(
		env,
		'webhook-url-secret',
		webhookContext,
	)
	expect(
		await decryptWebhookUrlSecret(env, webhookEncrypted, webhookContext),
	).toBe('webhook-url-secret')
	await expect(
		decryptWebhookUrlSecret(
			env,
			webhookEncrypted,
			userWebhookUrlSecretContext('user-a', 'endpoint-2'),
		),
	).rejects.toThrow('Unable to decrypt webhook URL secret.')
})
