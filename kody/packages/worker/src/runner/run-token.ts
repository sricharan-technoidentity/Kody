import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'

export type RunClaims = {
	userId: string
	runId: string
	expiresAt: number
	retriever: boolean
	provenance: Array<{
		moduleId: string
		packageId: string | null
		storageId: string
	}>
}

async function signingKey(secret: string) {
	if (secret.length < 32) throw new Error('Run token signing key is too short.')
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function validClaims(value: unknown): value is RunClaims {
	if (!value || typeof value !== 'object') return false
	const claim = value as RunClaims
	return (
		typeof claim.userId === 'string' &&
		claim.userId.length > 0 &&
		typeof claim.runId === 'string' &&
		claim.runId.length > 0 &&
		Number.isSafeInteger(claim.expiresAt) &&
		typeof claim.retriever === 'boolean' &&
		Array.isArray(claim.provenance) &&
		claim.provenance.length > 0 &&
		claim.provenance.every(
			(stamp) =>
				stamp &&
				typeof stamp.moduleId === 'string' &&
				stamp.moduleId.length > 0 &&
				(stamp.packageId === null || typeof stamp.packageId === 'string') &&
				typeof stamp.storageId === 'string' &&
				stamp.storageId.length > 0,
		) &&
		new Set(claim.provenance.map((stamp) => stamp.moduleId)).size ===
			claim.provenance.length
	)
}

/** Only trusted run activities mint tokens; the Runner receives no signing key. */
export async function mintRunToken(secret: string, claims: RunClaims) {
	if (!validClaims(claims)) throw new Error('Invalid run token claims.')
	const payload = utf8ToBase64Url(JSON.stringify(claims))
	const signature = await crypto.subtle.sign(
		'HMAC',
		await signingKey(secret),
		new TextEncoder().encode(payload),
	)
	return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export async function verifyRunToken(
	secret: string,
	token: string,
	options: { userId?: string; now?: number } = {},
): Promise<RunClaims> {
	if (token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
		throw new Error('Invalid run token.')
	const [payload, signature] = token.split('.') as [string, string]
	let claims: unknown
	try {
		const bytes = base64UrlToBytes(signature)
		if (
			bytes.length !== 32 ||
			bytesToBase64Url(bytes) !== signature ||
			!(await crypto.subtle.verify(
				'HMAC',
				await signingKey(secret),
				bytes,
				new TextEncoder().encode(payload),
			))
		)
			throw new Error('signature')
		claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		throw new Error('Invalid run token signature or payload.')
	}
	if (!validClaims(claims)) throw new Error('Invalid run token claims.')
	if (claims.expiresAt <= (options.now ?? Date.now()))
		throw new Error('Run token expired.')
	if (options.userId !== undefined && options.userId !== claims.userId)
		throw new Error('Run token owner mismatch.')
	return claims
}
