import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { getAvailableUsernameFromBase } from './generated-username.ts'
import { getUsernameValidationError } from './username.ts'

test('generated usernames suffix taken claimable bases and redraw reserved bases', async () => {
	await using fixture = await createTestDb()
	const db = createPgDatabase({ connection: fixture.pg, role: 'kody_admin' })
	const takenEmail = 'alice@example.com'
	const takenStableId = await createStableUserIdFromEmail(takenEmail)
	await db
		.prepare(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('alice', ?, ?, 'oauth_created_no_usable_password')`)
		.bind(takenEmail, takenStableId)
		.run()

	expect(await getAvailableUsernameFromBase(db, 'alice')).toBe('alice-2')

	const fromReserved = await getAvailableUsernameFromBase(db, 'support')
	expect(fromReserved).not.toBe('support')
	expect(fromReserved.includes('support')).toBe(false)
	expect(fromReserved.startsWith('user-')).toBe(false)
	expect(getUsernameValidationError(fromReserved)).toBeNull()
})
