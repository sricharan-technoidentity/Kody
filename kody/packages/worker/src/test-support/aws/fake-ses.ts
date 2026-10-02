export type Mail = { from: string; to: string; subject: string; body: string }

export function createFakeSes() {
	const outbox: Mail[] = []
	return {
		outbox,
		async send(mail: Mail) {
			outbox.push(structuredClone(mail))
		},
		inbound(mail: Mail) {
			return {
				eventType: 'EmailReceived' as const,
				mail: structuredClone(mail),
			}
		},
	}
}
