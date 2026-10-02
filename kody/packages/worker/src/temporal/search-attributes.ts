import { defineSearchAttributeKey } from '@temporalio/common'

/**
 * The only search attributes Kody sets. Visibility is not encrypted by the
 * payload codec, so these carry ids and states, never emails or names.
 */
export const kodySearchAttributes = {
	userId: defineSearchAttributeKey('KodyUserId', 'KEYWORD'),
	surface: defineSearchAttributeKey('KodySurface', 'KEYWORD'),
	packageId: defineSearchAttributeKey('KodyPackageId', 'KEYWORD'),
	status: defineSearchAttributeKey('KodyStatus', 'KEYWORD'),
} as const

export const kodySearchAttributeKeys = Object.values(kodySearchAttributes)
