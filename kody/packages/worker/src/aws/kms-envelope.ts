import {
	DecryptCommand,
	GenerateDataKeyCommand,
	KMSClient,
	type DecryptCommandOutput,
	type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms'
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'

export type KmsSend = (
	command: GenerateDataKeyCommand | DecryptCommand,
) => Promise<Partial<GenerateDataKeyCommandOutput & DecryptCommandOutput>>

/** Envelope port: production KMS here, `createFakeKms()` in tests. */
export type KmsEnvelope = {
	encrypt(
		plaintext: Uint8Array,
		context: Record<string, string>,
	): Promise<Uint8Array>
	decrypt(
		ciphertext: Uint8Array,
		context: Record<string, string>,
	): Promise<Uint8Array>
}

const version = 'kms1'

/** Same bytes for the same context regardless of key order. */
function contextAad(context: Record<string, string>) {
	return new TextEncoder().encode(
		JSON.stringify(
			Object.entries(context).sort(([a], [b]) => a.localeCompare(b)),
		),
	)
}

async function importDataKey(plaintext: Uint8Array | undefined) {
	if (!plaintext) throw new Error('KMS returned no data key.')
	try {
		return await crypto.subtle.importKey(
			'raw',
			plaintext.slice(),
			'AES-GCM',
			false,
			['encrypt', 'decrypt'],
		)
	} finally {
		plaintext.fill(0)
	}
}

/**
 * KMS envelope encryption. The encryption context (for user secrets
 * `{ userId }`, replacing AAD `user:<userId>`) binds both the KMS data key
 * and the AES-GCM payload, so a ciphertext copied to another user fails.
 * Payload: `kms1.<wrapped data key>.<iv>.<ciphertext>` as UTF-8 bytes.
 */
export function createKmsEnvelope(input: {
	region: string
	keyId: string
	send?: KmsSend
}): KmsEnvelope {
	const client = input.send
		? undefined
		: new KMSClient({ region: input.region })
	const send: KmsSend =
		input.send ?? ((command) => client!.send(command as GenerateDataKeyCommand))
	return {
		async encrypt(plaintext: Uint8Array, context: Record<string, string>) {
			// ponytail: one GenerateDataKey call per encrypt; cache data keys per context if secret writes get hot.
			const dataKey = await send(
				new GenerateDataKeyCommand({
					KeyId: input.keyId,
					KeySpec: 'AES_256',
					EncryptionContext: context,
				}),
			)
			if (!dataKey.CiphertextBlob) throw new Error('KMS returned no data key.')
			const key = await importDataKey(dataKey.Plaintext)
			const iv = crypto.getRandomValues(new Uint8Array(12))
			const data = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv, additionalData: contextAad(context) },
				key,
				plaintext.slice(),
			)
			return new TextEncoder().encode(
				[
					version,
					bytesToBase64Url(dataKey.CiphertextBlob),
					bytesToBase64Url(iv),
					bytesToBase64Url(new Uint8Array(data)),
				].join('.'),
			)
		},
		async decrypt(ciphertext: Uint8Array, context: Record<string, string>) {
			const [prefix, wrappedKey, iv, data, extra] = new TextDecoder()
				.decode(ciphertext)
				.split('.')
			if (prefix !== version || !wrappedKey || !iv || !data || extra) {
				throw new Error('Invalid KMS envelope payload.')
			}
			const { Plaintext } = await send(
				new DecryptCommand({
					KeyId: input.keyId,
					CiphertextBlob: base64UrlToBytes(wrappedKey),
					EncryptionContext: context,
				}),
			)
			const key = await importDataKey(Plaintext)
			return new Uint8Array(
				await crypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: base64UrlToBytes(iv),
						additionalData: contextAad(context),
					},
					key,
					base64UrlToBytes(data),
				),
			)
		},
	}
}
