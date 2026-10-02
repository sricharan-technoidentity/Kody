import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	PackageScopeAccessError,
	resolvePackageOwnerContext,
} from './package-owner.ts'
import { insertPackageScopeGrant } from './scope-grants.ts'

function reservedPlatformUsername() {
	return `kody-r-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function personUsername() {
	return `person-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function seedPersonUser(
	store: Awaited<ReturnType<typeof createTestDb>>,
	input: { username: string; email: string },
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	const result = await store.pg.query<{ id: number }>(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, account_type, plan)
		 VALUES ($1, $2, 'test-password-hash', $3, $4, 'person', 'max') RETURNING id`,
		[input.username, input.email, new Date().toISOString(), stableUserId],
	)
	return {
		id: Number(result.rows[0]?.id),
		username: input.username,
		email: input.email,
		stableUserId,
	}
}

test('resolvePackageOwnerContext returns caller ownership, grant delegation, and rejection paths', async () => {
	await using store = await createTestDb()
	// Scope grants and platform accounts are operator actions.
	const admin = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	// Each caller resolves its owner context through its own scoped writer.
	const envFor = (userId: string) =>
		({ APP_DB: store.forUser(userId).db }) as unknown as Env
	const person = await seedPersonUser(store, {
		username: personUsername(),
		email: `owner-${crypto.randomUUID()}@example.com`,
	})
	const actor = await seedPersonUser(store, {
		username: personUsername(),
		email: `actor-${crypto.randomUUID()}@example.com`,
	})
	const otherPerson = await seedPersonUser(store, {
		username: personUsername(),
		email: `other-${crypto.randomUUID()}@example.com`,
	})
	const platform = await createPlatformAccount({
		db: admin,
		forUser: (id) => store.forUser(id).db,
		email: `platform-${crypto.randomUUID()}@example.com`,
		username: reservedPlatformUsername(),
	})
	const personUser = {
		userId: person.stableUserId,
		email: person.email,
		displayName: person.username,
	}
	const actorUser = {
		userId: actor.stableUserId,
		email: actor.email,
		displayName: actor.username,
	}

	expect(
		await resolvePackageOwnerContext(envFor(person.stableUserId), personUser),
	).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: person.email,
		actorUserId: person.stableUserId,
		delegated: false,
	})

	// A person cannot grant themselves a platform scope.
	await expect(
		insertPackageScopeGrant(store.forUser(person.stableUserId).db, {
			scopeOwnerUserId: platform.stableUserId,
			granteeUserId: person.stableUserId,
			createdByUserId: person.stableUserId,
		}),
	).rejects.toThrow(/permission denied/)
	await insertPackageScopeGrant(admin, {
		scopeOwnerUserId: platform.stableUserId,
		granteeUserId: person.stableUserId,
		createdByUserId: person.stableUserId,
	})
	expect(
		await resolvePackageOwnerContext(
			envFor(person.stableUserId),
			personUser,
			platform.username,
		),
	).toEqual({
		ownerUserId: platform.stableUserId,
		ownerScope: platform.username,
		ownerEmail: platform.email,
		actorUserId: person.stableUserId,
		delegated: true,
	})

	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			otherPerson.username,
		),
	).rejects.toThrow(PackageScopeAccessError)
	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			otherPerson.username,
		),
	).rejects.toThrow(/not a platform account scope/)

	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			platform.username,
		),
	).rejects.toThrow(PackageScopeAccessError)
	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			platform.username,
		),
	).rejects.toThrow(/do not have a package scope grant/)

	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			'missing-scope-xyz',
		),
	).rejects.toThrow(PackageScopeAccessError)
	await expect(
		resolvePackageOwnerContext(
			envFor(actor.stableUserId),
			actorUser,
			'missing-scope-xyz',
		),
	).rejects.toThrow(/not a platform account scope/)

	// Email on the caller context can drift (for example mid-request email
	// change) while stable_user_id stays authoritative — package scope must
	// still resolve from identity, not email.
	const staleEmail = `stale-${crypto.randomUUID()}@example.com`
	expect(
		await resolvePackageOwnerContext(envFor(person.stableUserId), {
			userId: person.stableUserId,
			email: staleEmail,
			displayName: person.username,
		}),
	).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: staleEmail,
		actorUserId: person.stableUserId,
		delegated: false,
	})
})
