import { expect, test } from 'vitest'
import { createKmsEnvelope } from './kms-envelope.ts'

function createKms(options: { checkContext: boolean }) {
	const calls: Array<{ name: string; input: unknown }> = []
	const dataKeys = new Map<string, { key: Uint8Array; context: string }>()
	const kms = createKmsEnvelope({
		region: 'us-east-1',
		keyId: 'alias/kody-test',
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input })
			const context = JSON.stringify(command.input.EncryptionContext)
			if ('KeySpec' in command.input) {
				const id = `wrapped-${dataKeys.size}`
				const key = crypto.getRandomValues(new Uint8Array(32))
				dataKeys.set(id, { key, context })
				return {
					Plaintext: key.slice(),
					CiphertextBlob: new TextEncoder().encode(id),
				}
			}
			const id = new TextDecoder().decode(command.input.CiphertextBlob)
			const stored = dataKeys.get(id)
			if (!stored || (options.checkContext && stored.context !== context)) {
				throw Object.assign(new Error('InvalidCiphertextException'), {
					name: 'InvalidCiphertextException',
				})
			}
			return { Plaintext: stored.key.slice() }
		},
	})
	return { kms, calls }
}

test('KMS envelope round-trips under the user context and binds it in KMS and AES-GCM', async () => {
	const { kms, calls } = createKms({ checkContext: true })
	const secret = new TextEncoder().encode('sk-live-123')
	const sealed = await kms.encrypt(secret, { userId: 'alice' })
	expect(new TextDecoder().decode(sealed)).toMatch(
		/^kms1\.[\w-]+\.[\w-]+\.[\w-]+$/,
	)
	expect(new TextDecoder().decode(sealed)).not.toContain('sk-live-123')
	expect(await kms.decrypt(sealed, { userId: 'alice' })).toEqual(secret)
	await expect(kms.decrypt(sealed, { userId: 'bob' })).rejects.toThrow(
		'InvalidCiphertextException',
	)
	expect(calls.slice(0, 2)).toEqual([
		{
			name: 'GenerateDataKeyCommand',
			input: {
				KeyId: 'alias/kody-test',
				KeySpec: 'AES_256',
				EncryptionContext: { userId: 'alice' },
			},
		},
		{
			name: 'DecryptCommand',
			input: {
				KeyId: 'alias/kody-test',
				CiphertextBlob: new TextEncoder().encode('wrapped-0'),
				EncryptionContext: { userId: 'alice' },
			},
		},
	])

	// Even if KMS ignored the context, the payload AAD still rejects another user.
	const lax = createKms({ checkContext: false }).kms
	const laxSealed = await lax.encrypt(secret, { userId: 'alice' })
	await expect(lax.decrypt(laxSealed, { userId: 'bob' })).rejects.toMatchObject(
		{
			name: 'OperationError',
		},
	)
	const parts = new TextDecoder().decode(laxSealed).split('.')
	parts[3] = (parts[3]!.startsWith('A') ? 'B' : 'A') + parts[3]!.slice(1)
	const tampered = parts.join('.')
	await expect(
		lax.decrypt(new TextEncoder().encode(tampered), { userId: 'alice' }),
	).rejects.toMatchObject({ name: 'OperationError' })
	await expect(
		lax.decrypt(new TextEncoder().encode('v2.iv.data'), { userId: 'alice' }),
	).rejects.toThrow('Invalid KMS envelope payload')
})
