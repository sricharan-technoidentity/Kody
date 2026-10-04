import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import {
	accountSuspendedErrorCode,
	isAccountSuspendedError,
} from '#worker/account/account-suspension.ts'

export type PackageRealtimeBindingState = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}
export type PackageRealtimeEmitResult = { delivered: boolean; reason?: string }
export type PackageRealtimeBroadcastResult = {
	deliveredCount: number
	sessionIds: string[]
}
export type PackageRealtimeListResult = {
	sessions: {
		session_id: string
		facet: string
		topics: string[]
		connected_at: string
		last_seen_at: string
	}[]
}

export async function resolvePackageAppWorkerCacheKey(input: {
	env: Pick<Env, 'APP_DB'>
	binding: PackageRealtimeBindingState
}) {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.binding.sourceId,
	)
	if (!source || source.user_id !== input.binding.userId) {
		throw new Error('Saved package source was not found.')
	}
	return JSON.stringify([
		input.binding.userId,
		input.binding.packageId,
		input.binding.sourceId,
		input.binding.baseUrl,
		source.published_commit ?? null,
	])
}

export function packageRealtimeSessionRpc(
	input: PackageRealtimeBindingState & { env: Env },
) {
	const { env, userId, packageId } = input
	const key = { userId, packageId }
	const configured = env.REALTIME_SESSIONS
	if (!configured) throw new Error('Missing REALTIME_SESSIONS binding.')
	const store = configured
	async function ownerSuspended() {
		try {
			await resolveBackgroundMcpUser(env.APP_DB, userId)
			return false
		} catch (error) {
			if (!isAccountSuspendedError(error)) throw error
			await store.purge(key)
			return true
		}
	}
	// ponytail: realtime transport deferred; DynamoDB preserves session metadata, WebSocket delivery and package hooks require a Node transport adapter.
	return {
		async connect(_request: Request, _facet?: string | null) {
			if (await ownerSuspended())
				return Response.json(
					{
						ok: false,
						error: {
							code: accountSuspendedErrorCode,
							message: 'Account suspended.',
						},
					},
					{ status: 403 },
				)
			return Response.json(
				{
					ok: false,
					error: {
						code: 'realtime_transport_deferred',
						message: 'Realtime transport is deferred in the migration POC.',
					},
				},
				{ status: 501 },
			)
		},
		async emit(
			sessionId: string,
			_data: unknown,
		): Promise<PackageRealtimeEmitResult> {
			if (await ownerSuspended())
				return { delivered: false, reason: accountSuspendedErrorCode }
			const exists = (await store.list(key)).some(
				(session) => session.id === sessionId,
			)
			return {
				delivered: false,
				reason: exists
					? 'realtime_transport_deferred'
					: 'session_not_connected',
			}
		},
		async broadcast(_input: {
			data: unknown
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeBroadcastResult> {
			await ownerSuspended()
			return { deliveredCount: 0, sessionIds: [] }
		},
		async listSessions(filters?: {
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeListResult> {
			if (await ownerSuspended()) return { sessions: [] }
			const sessions = await store.list(key)
			return {
				sessions: sessions
					.filter(
						(session) =>
							(!filters?.facet || session.facet === filters.facet) &&
							(!filters?.topic || session.topics.includes(filters.topic)),
					)
					.map((session) => ({
						session_id: session.id,
						facet: session.facet,
						topics: session.topics,
						connected_at: session.connectedAt,
						last_seen_at: session.lastSeenAt,
					})),
			}
		},
		async disconnect(
			sessionId: string,
			_options?: { code?: number; reason?: string },
		) {
			await store.remove(key, sessionId)
			return { ok: true }
		},
		async purge() {
			await store.purge(key)
			return { ok: true as const }
		},
	}
}
