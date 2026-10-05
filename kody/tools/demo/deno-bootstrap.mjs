// Workers share stdio. Authenticate frames with a nonce never sent to the package.
const encoder = new TextEncoder()
let nonce
let sending = Promise.resolve()
const send = (value) => {
	const bytes = encoder.encode(JSON.stringify({ ...value, nonce }) + '\n')
	sending = sending.then(async () => {
		let offset = 0
		while (offset < bytes.length)
			offset += await Deno.stdout.write(bytes.subarray(offset))
	})
	return sending
}
let worker
let port
let buffer = ''
for await (const chunk of Deno.stdin.readable.pipeThrough(
	new TextDecoderStream(),
)) {
	buffer += chunk
	let end
	while ((end = buffer.indexOf('\n')) !== -1) {
		const input = JSON.parse(buffer.slice(0, end))
		buffer = buffer.slice(end + 1)
		if (!worker) {
			nonce = input.nonce
			worker = new Worker(input.workerUrl, {
				type: 'module',
				deno: { permissions: 'none' },
			})
			worker.onerror = (event) => {
				event.preventDefault()
				void send({ type: 'error', error: event.message })
			}
			const channel = new MessageChannel()
			port = channel.port1
			port.onmessage = (event) => void send(event.data)
			worker.postMessage(
				{
					port: channel.port2,
					graph: input.graph,
					moduleUrl: input.moduleUrl,
					statusTexts: input.statusTexts,
				},
				[channel.port2],
			)
		} else {
			port.postMessage(input)
		}
	}
}
worker?.terminate()
