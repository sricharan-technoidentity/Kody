import { expect, test } from 'vitest'
import { createFakeKms } from './fake-kms.ts'

test('KMS decrypt requires the original encryption context', async () => {
	const kms = createFakeKms()
	const plaintext = new TextEncoder().encode('secret')
	const encrypted = await kms.encrypt(plaintext, { userId: 'alice' })
	expect(await kms.decrypt(encrypted, { userId: 'alice' })).toEqual(plaintext)
	await expect(
		kms.decrypt(encrypted, { userId: 'bob' }),
	).rejects.toBeInstanceOf(Error)
})
