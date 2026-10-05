import { expect, test } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrokerHandler } from '#worker/broker/handler.ts'
import { mintRunToken } from '#worker/runner/run-token.ts'
import { startFrontDoorServer } from '#worker/front-door/server.ts'
import { buildRunner } from './build-runner.ts'
import { denoVersion, denoArm64Sha256 } from './prepare-deno.ts'
import { type startRunnerHost } from './runner-host.ts'

test(
	'clean standalone Deno artifact runs a referenced graph without legacy assets or source-tree bootstrap paths',
	{ timeout: 60000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'kody-artifact-test-'))
		const directory = join(root, 'runner')
		try {
			await buildRunner(directory)
			await symlink(
				resolve('node_modules'),
				join(directory, 'node_modules'),
				'dir',
			)
			const names = await readdir(directory)
			expect(names.sort()).toEqual([
				'Dockerfile',
				'deno-bootstrap.mjs',
				'deno-worker.mjs',
				'host.mjs',
				'node_modules',
				'package.json',
			])
			const manifest = JSON.parse(
				await readFile(join(directory, 'package.json'), 'utf8'),
			)
			expect(Object.keys(manifest.dependencies).sort()).toEqual([
				'@aws-sdk/client-s3',
				'@babel/parser',
				'esbuild',
			])
			const dockerfile = await readFile(join(directory, 'Dockerfile'), 'utf8')
			expect(dockerfile).toContain('linux/arm64')
			expect(dockerfile).toContain(`v${denoVersion}/deno-aarch64`)
			expect(dockerfile).toContain(denoArm64Sha256)
			expect(dockerfile).not.toMatch(/workerd|worker-bundler|__DENO_/)
			const signingKey = 'synthetic-artifact-signing-key-0123456789'
			const broker = createBrokerHandler({ signingKey })
			const unregister = broker.register({
				userId: 'alice',
				runId: 'artifact',
				async dispatch() {
					throw new Error('No capability expected')
				},
			})
			await using upstream = await startFrontDoorServer({ fetch: broker.fetch })
			// Import the built file so import.meta.url resolves its copied bootstrap, not tools/demo.
			const { startRunnerHost: startBuiltHost } = (await import(
				pathToFileURL(join(directory, 'host.mjs')).href
			)) as { startRunnerHost: typeof startRunnerHost }
			const host = await startBuiltHost({
				port: 0,
				host: '127.0.0.1',
				allowLocalHttp: true,
				brokerUrl: upstream.origin,
				egressUrl: upstream.origin,
				async readObject() {
					return {
						mainModule: 'entry.js',
						compatibilityDate: '2026-04-16',
						compatibilityFlags: [],
						modules: {
							'entry.js': `export default {evaluate(){return {version:Deno.version.deno, env:Deno.permissions.querySync({name:'env'}).state, net:Deno.permissions.querySync({name:'net'}).state}}}`,
						},
					}
				},
			})
			try {
				const token = await mintRunToken(signingKey, {
					userId: 'alice',
					runId: 'artifact',
					retriever: false,
					expiresAt: Date.now() + 60000,
					provenance: [
						{ moduleId: 'entry.js', packageId: null, storageId: 'execute' },
					],
				})
				const response = await fetch(`${host.origin}/invocations`, {
					method: 'POST',
					body: JSON.stringify({
						bundleKey: 'alice/runner-inputs/artifact.json',
						runId: 'artifact',
						runToken: token,
					}),
				})
				expect(response.status).toBe(200)
				expect(await response.json()).toEqual({
					version: denoVersion,
					env: 'denied',
					net: 'denied',
				})
			} finally {
				unregister()
				await host.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
