import { expect, test } from 'vitest'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { readMainWorkerWranglerCompatibility } from '#worker/test-support/wrangler-compatibility.ts'

test('dynamic worker compatibility matches the main wrangler config', () => {
	const mainWorker = readMainWorkerWranglerCompatibility()
	expect(createDynamicWorkerCompatibilityOptions()).toEqual({
		compatibilityDate: mainWorker.compatibilityDate,
		compatibilityFlags: mainWorker.compatibilityFlags,
	})
})
