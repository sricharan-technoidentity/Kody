// The transport is captured before importing package code and never exposed on globals.
globalThis.onmessage = async ({
	data: { port, graph, moduleUrl, statusTexts },
}) => {
	globalThis.onmessage = null
	const send = port.postMessage.bind(port)
	const bodyLimit = graph.bodyLimitBytes ?? 100 * 1024
	const NativeResponse = globalThis.Response
	const responseInit = (init = {}) => ({
		...init,
		statusText: init.statusText ?? statusTexts[init.status ?? 200] ?? '',
	})
	globalThis.Response = new Proxy(NativeResponse, {
		construct(target, [body, init], newTarget) {
			return Reflect.construct(target, [body, responseInit(init)], newTarget)
		},
		get(target, key) {
			if (key === 'json')
				return (data, init) => target.json(data, responseInit(init))
			if (key === 'redirect')
				return (url, status = 302) => {
					const response = target.redirect(url, status)
					return new target(
						null,
						responseInit({ status, headers: response.headers }),
					)
				}
			return Reflect.get(target, key)
		},
	})
	const pending = new Map()
	const boundedBytes = async (stream) => {
		const chunks = []
		let length = 0
		if (stream)
			for await (const chunk of stream) {
				length += chunk.length
				if (length > bodyLimit)
					throw new Error('Sandbox response limit exceeded.')
				chunks.push(chunk)
			}
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.length
		}
		return bytes
	}
	const base64 = (bytes) =>
		btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
	let sequence = 0
	const call = (kind, input, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason)
				return
			}
			const id = ++sequence
			const cancel = () => {
				pending.delete(id)
				send({ type: 'cancel', id })
				reject(signal.reason)
			}
			const cleanup = () => signal?.removeEventListener('abort', cancel)
			pending.set(id, {
				resolve: (value) => {
					cleanup()
					resolve(value)
				},
				reject: (error) => {
					cleanup()
					reject(error)
				},
			})
			signal?.addEventListener('abort', cancel, { once: true })
			send({ type: 'bridge', id, kind, ...input })
		})
	port.onmessage = ({ data }) => {
		const request = pending.get(data.id)
		if (!request) return
		pending.delete(data.id)
		if (data.error) request.reject(new Error(data.error))
		else request.resolve(data.result)
	}
	const waits = []
	const waitUntil = (promise) => {
		const guarded = Promise.resolve(promise).then(
			() => null,
			(error) => ({ error }),
		)
		waits.push(guarded)
	}
	const dispatcher = (provider) => ({
		call: (capability, json) =>
			call('capability', {
				capability: provider ? `${provider}.${capability}` : capability,
				arguments: JSON.parse(json),
			}),
	})
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		request.signal.throwIfAborted()
		const result = await call(
			'fetch',
			{
				url: request.url,
				method: request.method,
				headers: [...request.headers],
				body: request.body ? base64(await boundedBytes(request.body)) : null,
			},
			request.signal,
		)
		return new Response(
			[204, 205, 304].includes(result.status)
				? null
				: Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0)),
			result,
		)
	}
	let logBytes = 0
	const log = (method, args) => {
		const text = args.map(String).join(' ')
		logBytes += new TextEncoder().encode(text).length
		if (logBytes > 100 * 1024) throw new Error('Sandbox log limit exceeded.')
		send({ type: 'log', method, text })
	}
	for (const method of ['log', 'info', 'debug', 'warn', 'error'])
		console[method] = (...args) => log(method, args)
	// Deno's other console methods bypass console.log and write shared stdout.
	for (const method of Object.keys(console)) {
		if (
			typeof console[method] !== 'function' ||
			['log', 'info', 'debug', 'warn', 'error'].includes(method)
		)
			continue
		console[method] = (...args) => {
			if (method === 'assert' && args.shift()) return
			log(method, args)
		}
	}
	globalThis.addEventListener('unhandledrejection', (event) => {
		event.preventDefault()
		send({ type: 'error', error: String(event.reason) })
	})
	try {
		// Nested Workers would bypass the host's authorized-graph compiler.
		globalThis.Worker = undefined
		globalThis.process = { env: Object.freeze({}), stdout: { isTTY: false } }
		const module = await import(moduleUrl)
		const env = { ...graph.env }
		for (const [provider, methods] of Object.entries(
			graph.runtimeMethods ?? {},
		)) {
			env[provider] = Object.fromEntries(
				methods.map((method) => [
					method,
					async (...args) => {
						const response = JSON.parse(
							await dispatcher(provider).call(method, JSON.stringify(args)),
						)
						if (response.error) throw new Error(response.error)
						return response.result
					},
				]),
			)
		}
		const ctx = { waitUntil, props: {} }
		globalThis[Symbol.for('kody.deno.waitUntil')] = waitUntil
		const entry = module[graph.entrypointName ?? 'default']
		const instance = typeof entry === 'function' ? new entry(ctx, env) : entry
		let result
		if (graph.method === 'fetch') {
			const input = graph.invocation
			const body =
				input.body == null
					? null
					: Uint8Array.from(atob(input.body), (c) => c.charCodeAt(0))
			const response = await instance.fetch(
				new Request(input.url, { ...input, body }),
				env,
				ctx,
			)
			const bytes = await boundedBytes(response.body)
			result = {
				status: response.status,
				statusText: response.statusText,
				headers: [...response.headers],
				body: base64(bytes),
			}
		} else {
			const dispatchers = Object.fromEntries(
				(graph.providers ?? ['kody']).map((name) => [
					name,
					dispatcher(graph.providers ? name : undefined),
				]),
			)
			result = await instance.evaluate(dispatchers, graph.invocation ?? {})
		}
		for (let index = 0; index < waits.length; index++) {
			const failure = await waits[index]
			if (failure) throw failure.error
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
		send({ type: 'result', result })
	} catch (error) {
		send({
			type: 'error',
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
