import { expect, test } from 'vitest'
import { temporalServerOptions } from './temporal-options.ts'

test('local server controls use a supplied executable and keep UI loopback while test server remains separate', () => {
	expect(
		temporalServerOptions({ executable: '/tmp/temporal', uiPort: 8233 }),
	).toMatchObject({
		ip: '127.0.0.1',
		ui: true,
		uiPort: 8233,
		executable: { type: 'existing-path', path: '/tmp/temporal' },
	})
	expect(() => temporalServerOptions({ uiPort: -1 })).toThrow('port')
})
