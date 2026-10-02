import { expect, test } from 'vitest'
import { createFakeCodeInterpreter } from './fake-code-interpreter.ts'

test('code interpreter stores files, returns scripted checks and keeps the bundle output', async () => {
	const interpreter = createFakeCodeInterpreter()
	interpreter.writeFile('src/index.ts', new Uint8Array([1]))
	interpreter.respondWith('typecheck', { ok: true, output: '' })
	expect(interpreter.readFile('src/index.ts')).toEqual(new Uint8Array([1]))
	expect(await interpreter.run('typecheck')).toEqual({ ok: true, output: '' })
	interpreter.respondWith('bundle', { ok: true, output: 'export {}' })
	await interpreter.run('bundle')
	expect(new TextDecoder().decode(interpreter.readFile('dist/bundle.js'))).toBe(
		'export {}',
	)
	expect(interpreter.calls).toEqual(['typecheck', 'bundle'])
})
