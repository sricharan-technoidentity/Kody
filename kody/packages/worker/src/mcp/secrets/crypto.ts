import { type KmsEnvelope } from '#worker/aws/kms-envelope.ts'

/** KMS encryption context naming the owner of one ciphertext. */
export type SecretContext = Record<string, string>

/** Env surface for every Kody-held secret: the KMS envelope port. */
export type SecretCryptoEnv = { SECRET_KMS: KmsEnvelope }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * KMS envelope encryption. The purpose and the identity context (e.g. the
 * owning user) form the KMS encryption context, which binds both the data
 * key and the AES-GCM payload, so a ciphertext copied into another row or
 * purpose fails to decrypt. Ciphertext is stored as the envelope's text.
 */
async function encryptWithKms(
	env: SecretCryptoEnv,
	purpose: string,
	context: SecretContext,
	value: string,
) {
	return textDecoder.decode(
		await env.SECRET_KMS.encrypt(textEncoder.encode(value), {
			...context,
			purpose,
		}),
	)
}

async function decryptWithKms(
	env: SecretCryptoEnv,
	purpose: string,
	context: SecretContext,
	payload: string,
) {
	return textDecoder.decode(
		await env.SECRET_KMS.decrypt(textEncoder.encode(payload), {
			...context,
			purpose,
		}),
	)
}

const secretStorePurpose = 'mcp-secret-store'

/**
 * Platform OAuth client secrets share the KMS key but use a
 * dedicated purpose so their ciphertext is never interchangeable with
 * `secret_entries` payloads. They live outside the user secret store on
 * purpose: nothing in the `{{secret:...}}` placeholder namespace can name
 * them, so sandboxed code has no resolution path to the shared credential.
 */
const platformOauthClientSecretPurpose = 'platform-oauth-client-secret'
const userOauthAccessTokenPurpose = 'user-oauth-access-token'
const userOauthRefreshTokenPurpose = 'user-oauth-refresh-token'
const userOauthClientSecretPurpose = 'user-oauth-client-secret'
const webhookUrlSecretPurpose = 'webhook-url-secret'

/** KMS context for a user-owned secret ciphertext (was AAD `user:<userId>`). */
export function userSecretContext(userId: string): SecretContext {
	return { userId }
}

/** KMS context for a platform OAuth app client secret ciphertext. */
export function platformOauthAppContext(slug: string): SecretContext {
	return { app: slug }
}

/** KMS context for a user-lane OAuth connection token ciphertext. */
export function userIntegrationCredentialContext(
	userId: string,
	integrationName: string,
): SecretContext {
	return { userId, integration: integrationName }
}

/** KMS context for a user-lane OAuth app client secret ciphertext. */
export function userOauthAppCredentialContext(
	userId: string,
	slug: string,
): SecretContext {
	return { userId, oauthApp: slug }
}

export async function encryptPlatformOauthClientSecret(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, platformOauthClientSecretPurpose, context, value)
}

export async function decryptPlatformOauthClientSecret(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(
			env,
			platformOauthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt platform client secret.')
	}
}

export async function encryptUserOauthAccessToken(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, userOauthAccessTokenPurpose, context, value)
}

export async function decryptUserOauthAccessToken(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(
			env,
			userOauthAccessTokenPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt integration access token.')
	}
}

export async function encryptUserOauthRefreshToken(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, userOauthRefreshTokenPurpose, context, value)
}

export async function decryptUserOauthRefreshToken(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(
			env,
			userOauthRefreshTokenPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt integration refresh token.')
	}
}

export async function encryptUserOauthClientSecret(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, userOauthClientSecretPurpose, context, value)
}

export async function decryptUserOauthClientSecret(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(
			env,
			userOauthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt OAuth app client secret.')
	}
}

/** KMS context for a minted webhook URL secret ciphertext. */
export function userWebhookUrlSecretContext(
	userId: string,
	endpointId: string,
): SecretContext {
	return { userId, webhookEndpoint: endpointId }
}

export async function encryptWebhookUrlSecret(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, webhookUrlSecretPurpose, context, value)
}

export async function decryptWebhookUrlSecret(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(env, webhookUrlSecretPurpose, context, payload)
	} catch {
		throw new Error('Unable to decrypt webhook URL secret.')
	}
}

export async function encryptSecretValue(
	env: SecretCryptoEnv,
	value: string,
	context: SecretContext,
) {
	return encryptWithKms(env, secretStorePurpose, context, value)
}

export async function decryptSecretValue(
	env: SecretCryptoEnv,
	payload: string,
	context: SecretContext,
) {
	try {
		return await decryptWithKms(env, secretStorePurpose, context, payload)
	} catch {
		throw new Error('Unable to decrypt secret value.')
	}
}
