import { expect, test } from 'vitest'
import { createFakeSes } from './fake-ses.ts'

test('SES records outbound mail and builds inbound events', async () => {
	const ses = createFakeSes()
	const mail = { from: 'a@test', to: 'b@test', subject: 'hi', body: 'hello' }
	await ses.send(mail)
	expect(ses.outbox).toEqual([mail])
	expect(ses.inbound(mail)).toEqual({ eventType: 'EmailReceived', mail })
})
