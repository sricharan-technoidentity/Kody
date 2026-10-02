import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import { CommunityActionError } from './errors.ts'
import { getCommunityBan } from './repo.ts'

export async function assertNotCommunityBanned(
	db: SqlDatabase,
	userId: string,
) {
	const ban = await getCommunityBan(db, userId)
	if (ban) {
		throw new CommunityActionError('banned from community participation')
	}
}
