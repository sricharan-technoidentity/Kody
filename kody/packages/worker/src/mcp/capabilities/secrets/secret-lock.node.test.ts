import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'
import { testSecretKms } from '#worker/test-support/aws/fake-kms.ts'

import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	listSecrets,
	lockSecretToPackage,
	saveSecret,
} from '#mcp/secrets/service.ts'

import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { secretLockCapability } from './secret-lock.ts'

async function createHarness() {
	const database = await createTestDb({ userId: 'user-secret-lock' })
	const sqlite = database.pg

	const env = {
		APP_DB: database.db,
		SECRET_KMS: testSecretKms,
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env, [Symbol.asyncDispose]: database[Symbol.asyncDispose] }
}

async function seedPackage(
	sqlite: Awaited<ReturnType<typeof createTestDb>>['pg'],
	input: { id: string; userId: string; kodyId: string },
) {
	await pgQuery(sqlite).run(
		`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		input.id,
		input.userId,
		input.kodyId,
		input.kodyId,
		'',
		`source-${input.id}`,
	)
}

async function allowedPackagesFor(
	env: Env,
	userId: string,
	name: string,
): Promise<Array<string>> {
	const secrets = await listSecrets({ env, userId, scope: 'user' })
	return secrets.find((secret) => secret.name === name)?.allowedPackages ?? []
}

test('secretLock returns an approval URL without widening allowed_packages', async () => {
	await using harness = await createHarness()
	const { sqlite, env } = harness
	const userId = 'user-secret-lock'
	await seedPackage(sqlite, { id: 'pkg-notes', userId, kodyId: 'notes' })
	await seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'openai-api-key',
		value: 'sk-test',
	})

	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.codes',
			user: {
				userId,
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}

	const approvalUrl =
		'https://kody.codes/account/secrets/user/openai-api-key?package_id=pkg-notes&package=notes'
	const pending = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(pending).toEqual({
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: [],
		usage_url: 'https://kody.codes/account/secrets/user/openai-api-key',
		status: 'approval_required',
		approval_url: approvalUrl,
		message: expect.stringContaining(approvalUrl),
	})
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([])

	const websiteGrant = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
	})
	expect(websiteGrant.allowedPackages).toEqual(['pkg-notes'])

	const alreadyGranted = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(alreadyGranted).toEqual({
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: ['pkg-notes'],
		usage_url: 'https://kody.codes/account/secrets/user/openai-api-key',
		status: 'already_granted',
		approval_url: approvalUrl,
		message: expect.any(String),
	})
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const additional = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-mail' },
		ctx,
	)
	expect(additional.status).toBe('approval_required')
	expect(additional.allowed_packages).toEqual(['pkg-notes'])
	expect(additional.approval_url).toBe(
		'https://kody.codes/account/secrets/user/openai-api-key?package_id=pkg-mail&package=mail',
	)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const missingPackage = await secretLockCapability
		.handler({ name: 'openai-api-key', package_id: 'missing' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingPackage).toBeInstanceOf(McpCallerError)
	expect((missingPackage as Error).message).toContain('Saved package not found')

	const missingSecret = await secretLockCapability
		.handler({ name: 'missing-secret', package_id: 'pkg-notes' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingSecret).toBeInstanceOf(McpCallerError)
	expect((missingSecret as Error).message).toContain(
		'Secret not found for this scope.',
	)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])
})
