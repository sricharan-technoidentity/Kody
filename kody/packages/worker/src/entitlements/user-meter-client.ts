import { type EntitlementResource } from '#universal/plans.ts'

/** Daily rate-style resources stored in the per-user UserMeter (UTC day keys). */
export const dailyEntitlementResources = [
	'email_sends_per_day',
	'email_receives_per_day',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
] as const satisfies ReadonlyArray<EntitlementResource>

export type DailyEntitlementResource =
	(typeof dailyEntitlementResources)[number]

export function isDailyEntitlementResource(
	resource: string,
): resource is DailyEntitlementResource {
	return (dailyEntitlementResources as ReadonlyArray<string>).includes(resource)
}

/**
 * Retention window for UserMeter daily rows. Enforcement needs today and,
 * for execute/outbound, the current UTC week (Monday–Sunday). Seven days
 * covers that week.
 */
export const userMeterDailyCounterRetentionDays = 7

/**
 * D1 enumeration-inventory `updated_at` token. Lexicographic order matches
 * revision order, and `r/` sorts after ISO timestamps.
 */
export function userMeterMirrorUpdatedAtToken(revision: number): string {
	const safeRevision =
		Number.isSafeInteger(revision) && revision > 0 ? revision : 0
	return `r/${String(safeRevision).padStart(20, '0')}`
}

export type UserMeterCounterRow = {
	resource: DailyEntitlementResource
	day: string
	count: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterReadyState = {
	outcome: 'ready'
	count: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterBootstrapState = {
	outcome: 'needs_bootstrap'
}

export type UserMeterDeniedWindow = 'day' | 'week'

export type UserMeterConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			consumed: boolean
			deniedWindow?: UserMeterDeniedWindow
			weekCount?: number
	  })

export type UserMeterReadResult = UserMeterBootstrapState | UserMeterReadyState

export type UserMeterRefundResult = UserMeterReadyState

export type UserMeterInitializeResult = UserMeterReadyState & {
	created: boolean
}

export type UserMeterStorageBytesState = {
	bytes: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadyState = {
	outcome: 'ready'
	bytes: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadResult =
	| UserMeterBootstrapState
	| UserMeterStorageBytesReadyState

export type UserMeterStorageBytesReserveResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { reserved: boolean })

export type UserMeterStorageBytesInitializeResult =
	UserMeterStorageBytesReadyState & {
		created: boolean
	}

export type UserMeterStorageBytesSetResult = UserMeterStorageBytesReadyState & {
	created: boolean
}

/**
 * Result of a revision-guarded absolute reconciliation CAS.
 * `needs_bootstrap` when the singleton is absent; `applied` distinguishes a
 * successful overwrite from a CAS miss caused by a concurrent reserve.
 */
export type UserMeterStorageBytesReconcileResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { applied: boolean })

/** Paged write-lease entry returned by {@link UserMeterRpc.listWriteLeases}. */
export type UserMeterWriteLeaseEntry = {
	token: string
	holder: string
	acquiredAt: string
}

/**
 * Account-export deletion inventory. Omits raw lease token and holder; retains
 * only deleting tombstone presence, active lease count, and acquired_at.
 */
export type UserMeterDeletionStateExport = {
	deletingAt: string | null
	activeWriteLeaseCount: number
	writeLeases: Array<{ acquiredAt: string }>
}

export type UserMeterMarkDeletingResult = {
	deletingAt: string
	created: boolean
	/** Count of active write leases (DO-authority rows) at the time of marking. */
	leaseCount: number
}

export type UserMeterClearDeletingResult = {
	cleared: boolean
}

export type UserMeterAcquireWriteLeaseResult = {
	acquired: boolean
}

export type UserMeterReleaseWriteLeaseResult = {
	released: boolean
}

export type UserMeterAssertWriteLeaseHeldResult = {
	held: boolean
}

export type UserMeterPrepareWriteLeaseRepairResult =
	| {
			prepared: true
			repairId: string
			token: string
			holder: string
			acquiredAt: string
	  }
	| { prepared: false }

export type UserMeterFinalizeWriteLeaseRepairResult = {
	finalized: boolean
}

export type UserMeterWriteLeaseListResult = {
	leases: Array<UserMeterWriteLeaseEntry>
	nextStartAfter: string | null
	truncated: boolean
}

export type UserMeterWriteLeaseCountResult = {
	count: number
}

export type UserMeterInboundConnectionLastUsedRow = {
	clientId: string
	lastUsedAt: string
}

export type UserMeterExportResult = {
	counters: Array<UserMeterCounterRow>
	/**
	 * Authoritative storage-byte state. Emitted only on the first export page
	 * (`startAfter` absent); subsequent pages return `null` so paged consumers
	 * never double-count it.
	 */
	storageBytesState: UserMeterStorageBytesState | null
	/**
	 * Sanitized deletion-fence / write-lease inventory. Emitted only on the
	 * first export page (`startAfter` absent); subsequent pages return `null`
	 * so paged consumers never double-count. Excludes raw lease token and
	 * holder (see {@link UserMeterDeletionStateExport}).
	 */
	deletionState: UserMeterDeletionStateExport | null
	/**
	 * Inbound MCP OAuth `clientId` last-heard times. Emitted only on the first
	 * export page (`startAfter` absent); subsequent pages return `null`.
	 */
	inboundConnectionLastUsed: Array<UserMeterInboundConnectionLastUsedRow> | null
	nextStartAfter: string | null
	truncated: boolean
}

/**
 * Inbound delivery claim + receive consume. Retries set `replayed` without
 * incrementing; `day`/`resource` come from the original claim on cross-day
 * retries.
 */
export type UserMeterInboundDeliveryConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			consumed: boolean
			replayed: boolean
			day: string
			resource: 'email_receives_per_day'
	  })

export type UserMeterRpc = {
	initialize: (input: {
		resource: string
		day: string
		count: number
		updatedAt: string
	}) => Promise<UserMeterInitializeResult>
	consume: (input: {
		resource: string
		day: string
		limit: number
		updatedAt: string
		weekStart?: string
		weekLimit?: number | null
	}) => Promise<UserMeterConsumeResult>
	readRange: (input: {
		resource: string
		startDay: string
		endDay: string
		now?: string
	}) => Promise<{ outcome: 'ready'; count: number }>
	consumeInboundDelivery: (input: {
		deliveryId: string
		resource: string
		day: string
		limit: number
		updatedAt: string
	}) => Promise<UserMeterInboundDeliveryConsumeResult>
	read: (input: {
		resource: string
		day: string
		now?: string
	}) => Promise<UserMeterReadResult>
	refund: (input: {
		resource: string
		day: string
		updatedAt: string
	}) => Promise<UserMeterRefundResult>
	/** First-seen unique Dynamic Worker id for a UTC day. */
	claimDynamicWorkerDay: (input: {
		workerId: string
		day: string
		createdAt: string
	}) => Promise<{ created: boolean }>
	/** Cold initialize authoritative state from a caller-provided physical byte count. */
	initializeStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesInitializeResult>
	/** Authoritative storage-byte usage read. */
	readStorageBytes: () => Promise<UserMeterStorageBytesReadResult>
	/** Authoritative atomic storage-byte reserve. */
	reserveStorageBytes: (input: {
		requested: number
		limit: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReserveResult>
	/** Absolute maintenance set; use revision CAS for live reconciliation. */
	setStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesSetResult>
	/**
	 * Revision-guarded absolute reconciliation CAS. Applies `bytes` only when
	 * current revision equals `expectedRevision`. Returns `needs_bootstrap` if
	 * the singleton is absent; `applied: false` on a CAS miss.
	 */
	reconcileStorageBytes: (input: {
		bytes: number
		expectedRevision: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReconcileResult>
	/** Authoritative deletion mark; preserves tombstone. Returns active write-lease count. */
	markDeleting: (input: {
		deletingAt: string
	}) => Promise<UserMeterMarkDeletingResult>
	/** Drop the deletion tombstone after a pre-cleanup abort. */
	clearDeleting: (input?: {
		expectedDeletingAt?: string
	}) => Promise<UserMeterClearDeletingResult>
	/** Authoritative lease acquire. */
	acquireWriteLease: (input: {
		token: string
		holder: string
		acquiredAt: string
	}) => Promise<UserMeterAcquireWriteLeaseResult>
	/** Authoritative lease release. */
	releaseWriteLease: (input: {
		token: string
	}) => Promise<UserMeterReleaseWriteLeaseResult>
	/** Post-write held check; pending repair still counts as held. */
	assertWriteLeaseHeld: (input: {
		token: string
	}) => Promise<UserMeterAssertWriteLeaseHeldResult>
	/** Prepare an audit-safe lease repair; retries reuse repairId. */
	prepareWriteLeaseRepair: (input: {
		token: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterPrepareWriteLeaseRepairResult>
	/** Finalize an exact pending repair by deleting the lease. */
	finalizeWriteLeaseRepair: (input: {
		token: string
		repairId: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterFinalizeWriteLeaseRepairResult>
	/** Deletion tombstone read (D1 deleting_at remains the permanent gate). */
	readDeletionState: () => Promise<{ deletingAt: string | null }>
	/** Paged lease list. */
	listWriteLeases: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterWriteLeaseListResult>
	/** Active lease count (pending repair still counts). */
	countActiveWriteLeases: () => Promise<UserMeterWriteLeaseCountResult>
	touchInboundConnectionLastUsed: (input: {
		clientId: string
		lastUsedAt: string
	}) => Promise<{ updated: boolean }>
	listInboundConnectionLastUsed: () => Promise<
		Array<UserMeterInboundConnectionLastUsedRow>
	>
	forgetInboundConnectionLastUsed: (input: {
		clientId: string
	}) => Promise<{ ok: true }>
	purge: () => Promise<{ ok: true }>
	exportCounters: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterExportResult>
}

/** Per-user meter stores keyed by stable user id (DynamoDB `meters` in production). */
export type UserMeters = { forUser(userId: string): UserMeterRpc }

export type UserMeterEnv = {
	USER_METERS?: UserMeters
}

export function userMeterNamespace(env: UserMeterEnv): UserMeters | null {
	return env.USER_METERS ?? null
}

/** Typed per-user UserMeter; throws when `USER_METERS` is missing. */
export function userMeterRpc(input: {
	env: UserMeterEnv
	userId: string
}): UserMeterRpc {
	const meters = userMeterNamespace(input.env)
	if (!meters) {
		throw new Error('USER_METERS binding is not configured.')
	}
	return meters.forUser(input.userId)
}
