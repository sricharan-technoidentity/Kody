import { bytesToBase64Url } from '../base64.ts'
import { sha256Hex } from '../sha256.ts'
import { timingSafeEqualString } from '../timing-safe.ts'

export const temporalSignatureHeaders = {
	keyId: 'x-kody-key-id',
	timestamp: 'x-kody-timestamp',
	nonce: 'x-kody-nonce',
	bodyDigest: 'x-kody-content-sha256',
	signature: 'x-kody-signature',
	idempotencyKey: 'x-kody-idempotency-key',
} as const

export type TemporalSigningKey = {
	id: string
	secret: string
}

export type TemporalSignatureVerification =
	| { ok: true; keyId: string; idempotencyKey: string }
	| {
			ok: false
			code:
				| 'missing_header'
				| 'unknown_key'
				| 'expired'
				| 'invalid_digest'
				| 'invalid_signature'
				| 'replayed'
	  }

async function hmacSha256(secret: string, value: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const digest = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(value),
	)
	return bytesToBase64Url(new Uint8Array(digest))
}

function canonicalRequest(input: {
	method: string
	pathname: string
	timestamp: string
	nonce: string
	bodyDigest: string
	idempotencyKey: string
}) {
	return [
		input.method.toUpperCase(),
		input.pathname,
		input.timestamp,
		input.nonce,
		input.bodyDigest,
		input.idempotencyKey,
	].join('\n')
}

export async function createTemporalSignature(input: {
	key: TemporalSigningKey
	method: string
	pathname: string
	body: string
	idempotencyKey: string
	nonce?: string
	timestampMs?: number
}) {
	const timestamp = String(input.timestampMs ?? Date.now())
	const nonce = input.nonce ?? crypto.randomUUID()
	const bodyDigest = await sha256Hex(input.body)
	const signature = await hmacSha256(
		input.key.secret,
		canonicalRequest({
			method: input.method,
			pathname: input.pathname,
			timestamp,
			nonce,
			bodyDigest,
			idempotencyKey: input.idempotencyKey,
		}),
	)
	return {
		[temporalSignatureHeaders.keyId]: input.key.id,
		[temporalSignatureHeaders.timestamp]: timestamp,
		[temporalSignatureHeaders.nonce]: nonce,
		[temporalSignatureHeaders.bodyDigest]: bodyDigest,
		[temporalSignatureHeaders.signature]: signature,
		[temporalSignatureHeaders.idempotencyKey]: input.idempotencyKey,
	}
}

export async function verifyTemporalSignature(input: {
	keys: ReadonlyArray<TemporalSigningKey>
	headers: Headers
	method: string
	pathname: string
	body: string
	nowMs?: number
	maxClockSkewMs?: number
	consumeNonce: (input: {
		keyId: string
		nonce: string
		expiresAtMs: number
	}) => Promise<boolean>
}): Promise<TemporalSignatureVerification> {
	const keyId = input.headers.get(temporalSignatureHeaders.keyId)
	const timestamp = input.headers.get(temporalSignatureHeaders.timestamp)
	const nonce = input.headers.get(temporalSignatureHeaders.nonce)
	const claimedDigest = input.headers.get(temporalSignatureHeaders.bodyDigest)
	const claimedSignature = input.headers.get(temporalSignatureHeaders.signature)
	const idempotencyKey = input.headers.get(
		temporalSignatureHeaders.idempotencyKey,
	)
	if (
		!keyId ||
		!timestamp ||
		!nonce ||
		!claimedDigest ||
		!claimedSignature ||
		!idempotencyKey
	) {
		return { ok: false, code: 'missing_header' }
	}
	const key = input.keys.find((candidate) => candidate.id === keyId)
	if (!key) return { ok: false, code: 'unknown_key' }
	const timestampMs = Number(timestamp)
	const nowMs = input.nowMs ?? Date.now()
	const maxClockSkewMs = input.maxClockSkewMs ?? 5 * 60_000
	if (
		!Number.isSafeInteger(timestampMs) ||
		Math.abs(nowMs - timestampMs) > maxClockSkewMs
	) {
		return { ok: false, code: 'expired' }
	}
	const actualDigest = await sha256Hex(input.body)
	if (!(await timingSafeEqualString(actualDigest, claimedDigest))) {
		return { ok: false, code: 'invalid_digest' }
	}
	const expectedSignature = await hmacSha256(
		key.secret,
		canonicalRequest({
			method: input.method,
			pathname: input.pathname,
			timestamp,
			nonce,
			bodyDigest: claimedDigest,
			idempotencyKey,
		}),
	)
	if (!(await timingSafeEqualString(expectedSignature, claimedSignature))) {
		return { ok: false, code: 'invalid_signature' }
	}
	const consumed = await input.consumeNonce({
		keyId,
		nonce,
		expiresAtMs: timestampMs + maxClockSkewMs,
	})
	if (!consumed) return { ok: false, code: 'replayed' }
	return { ok: true, keyId, idempotencyKey }
}

export function parseTemporalSigningKeys(value: string) {
	const keys = JSON.parse(value) as unknown
	if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
		throw new Error(
			'Signing keys must contain the current and optional previous key.',
		)
	}
	return keys.map((candidate) => {
		if (
			typeof candidate !== 'object' ||
			candidate === null ||
			!('id' in candidate) ||
			!('secret' in candidate) ||
			typeof candidate.id !== 'string' ||
			typeof candidate.secret !== 'string' ||
			!candidate.id ||
			candidate.secret.length < 32
		) {
			throw new Error('Invalid signing key configuration.')
		}
		return { id: candidate.id, secret: candidate.secret }
	})
}
