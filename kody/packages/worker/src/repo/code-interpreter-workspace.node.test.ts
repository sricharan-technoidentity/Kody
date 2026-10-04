import { expect, test } from 'vitest'
import { createRepoCodeInterpreterFake } from '#worker/test-support/repo-code-interpreter.ts'
import { Workspace } from './code-interpreter-workspace.ts'

test('snapshot glob finds package documentation with relative roots', async () => {
	const session = createRepoCodeInterpreterFake().session('alice', 'editing')
	await session.filesystem.mkdir('/session', { recursive: true })
	await session.filesystem.writeFile(
		'/session/README.md',
		'Report instructions',
	)
	await session.filesystem.writeFile(
		'/session/AGENTS.md',
		'Report agent instructions',
	)
	const workspace = new Workspace(session)
	expect(
		(await workspace.glob('session/**/*')).map((file) => file.path),
	).toEqual(['/session/README.md', '/session/AGENTS.md'])
})
