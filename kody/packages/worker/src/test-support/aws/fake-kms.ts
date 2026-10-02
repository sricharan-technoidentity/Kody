import { webcrypto } from 'node:crypto'

const bytes = new TextEncoder()

function contextBytes(context: Record<string, string>) {
	return bytes.encode(
		JSON.stringify(
			Object.entries(context).sort(([a], [b]) => a.localeCompare(b)),
		),
	)
}

export function createFakeKms() {
	const masterKey = webcrypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
	const encode = (value: Uint8Array) => Buffer.from(value).toString('base64')
	const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
	return {
		async encrypt(plaintext: Uint8Array, context: Record<string, string>) {
			const dataKey = await webcrypto.subtle.generateKey(
				{ name: 'AES-GCM', length: 256 },
				true,
				['encrypt', 'decrypt'],
			)
			const dataIv = webcrypto.getRandomValues(new Uint8Array(12))
			const keyIv = webcrypto.getRandomValues(new Uint8Array(12))
			const data = await webcrypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: dataIv, additionalData: contextBytes(context) },
				dataKey,
				new Uint8Array(plaintext),
			)
			const key = await webcrypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: keyIv, additionalData: contextBytes(context) },
				await masterKey,
				await webcrypto.subtle.exportKey('raw', dataKey),
			)
			return bytes.encode(
				JSON.stringify({
					dataIv: encode(dataIv),
					keyIv: encode(keyIv),
					data: encode(new Uint8Array(data)),
					key: encode(new Uint8Array(key)),
				}),
			)
		},
		async decrypt(ciphertext: Uint8Array, context: Record<string, string>) {
			const envelope = JSON.parse(new TextDecoder().decode(ciphertext)) as {
				dataIv: string
				keyIv: string
				data: string
				key: string
			}
			const rawKey = await webcrypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: decode(envelope.keyIv),
					additionalData: contextBytes(context),
				},
				await masterKey,
				decode(envelope.key),
			)
			const dataKey = await webcrypto.subtle.importKey(
				'raw',
				rawKey,
				{ name: 'AES-GCM' },
				false,
				['decrypt'],
			)
			return new Uint8Array(
				await webcrypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: decode(envelope.dataIv),
						additionalData: contextBytes(context),
					},
					dataKey,
					decode(envelope.data),
				),
			)
		},
	}
}

/** One process-wide fake key, so separately built test envs share ciphertexts. */
export const testSecretKms = createFakeKms()
