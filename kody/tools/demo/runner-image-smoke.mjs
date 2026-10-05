import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

// Run inside the built image with --network none; only the container's loopback is used.
assert.equal(process.arch, 'arm64')
assert.notEqual(process.getuid(), 0)
const { startRunnerHost } = await import('/app/host.mjs')
const graph = {
	mainModule: 'smoke.js',
	compatibilityDate: '2026-04-16',
	compatibilityFlags: [],
	method: 'evaluate',
	invocation: {},
	modules: {
		'smoke.js': `export default {async evaluate(){
      const permissions = [];
      for (const action of [() => Deno.env.get('HOME'), () => Deno.readTextFile('/etc/passwd'), () => Deno.connect({hostname:'169.254.170.2',port:80}), () => Deno.connect({hostname:'127.0.0.1',port:8080})]) {
        try { await action(); permissions.push('allowed'); } catch { permissions.push('denied'); }
      }
      return {version: Deno.version.deno, architecture: Deno.build.arch, permissions};
    }}`,
	},
}
let reads = 0
let authorizations = 0
const broker = createServer((request, response) => {
	assert.equal(request.url, '/authorize')
	assert.equal(request.headers['x-kody-run-token'], 'smoke-token')
	authorizations++
	response.setHeader('content-type', 'application/json')
	response.end(JSON.stringify({ userId: 'smoke-owner', runId: 'smoke-run' }))
})
broker.listen(0, '127.0.0.1')
await once(broker, 'listening')
const brokerUrl = `http://127.0.0.1:${broker.address().port}`
let host
try {
	host = await startRunnerHost({
		brokerUrl,
		egressUrl: brokerUrl,
		allowLocalHttp: true,
		host: '127.0.0.1',
		async readObject(key) {
			assert.equal(key, 'smoke-owner/runner-inputs/smoke-run.json')
			reads++
			return graph
		},
	})
	const ping = await fetch(`${host.origin}/ping`)
	assert.equal(ping.status, 200)
	assert.equal((await ping.json()).status, 'Healthy')
	const response = await fetch(`${host.origin}/invocations`, {
		method: 'POST',
		body: JSON.stringify({
			bundleKey: 'smoke-owner/runner-inputs/smoke-run.json',
			runId: 'smoke-run',
			runToken: 'smoke-token',
		}),
		signal: AbortSignal.timeout(60000),
	})
	assert.equal(response.status, 200, await response.clone().text())
	assert.deepEqual(await response.json(), {
		version: '2.9.7',
		architecture: 'aarch64',
		permissions: ['denied', 'denied', 'denied', 'denied'],
	})
	assert.equal(reads, 1)
	assert.equal(authorizations, 1)
} finally {
	await host?.close()
	broker.closeAllConnections()
	await new Promise((resolve) => broker.close(resolve))
}
await assert.rejects(fetch(host.origin, { signal: AbortSignal.timeout(1000) }))
console.info(
	'ARM64 Runner smoke passed: port 8080, health, Deno invocation, denied permissions and shutdown.',
)
