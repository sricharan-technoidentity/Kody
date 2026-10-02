import { expect, test } from 'vitest'
import {
	createUserTestEnv,
	seedSavedPackage,
} from '#worker/test-support/aws/user-test-env.ts'
import { lockSecretToPackage, saveSecret } from './service.ts'

test('lockSecretToPackage adds a package grant and rejects unknown packages', async () => {
	const userId = 'user-secret-lock'
	await using harness = await createUserTestEnv({ userId })
	const { env } = harness
	await seedSavedPackage(harness.pg, {
		id: 'pkg-notes',
		userId,
		kodyId: 'notes',
	})
	await seedSavedPackage(harness.pg, { id: 'pkg-mail', userId, kodyId: 'mail' })

	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'openai-api-key',
		value: 'sk-test',
	})

	const locked = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
	})
	expect(locked).toMatchObject({
		name: 'openai-api-key',
		scope: 'user',
		allowedPackages: ['pkg-notes'],
	})

	const grantedAgain = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-mail',
	})
	expect(grantedAgain.allowedPackages).toEqual(['pkg-mail', 'pkg-notes'])

	const idempotent = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
	})
	expect(idempotent.allowedPackages).toEqual(['pkg-mail', 'pkg-notes'])

	await expect(
		lockSecretToPackage({
			env,
			userId,
			name: 'openai-api-key',
			packageId: 'missing-package',
		}),
	).rejects.toThrow('Saved package not found for this user.')
	await expect(
		lockSecretToPackage({
			env,
			userId,
			name: 'missing-secret',
			packageId: 'pkg-notes',
		}),
	).rejects.toThrow('Secret not found for this scope.')
})
