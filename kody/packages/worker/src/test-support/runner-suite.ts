import { afterAll } from 'vitest'
import { createRunnerTestEnv } from './runner.ts'

// One isolated compatibility environment per test file; authored modules run in fresh Deno sandboxes.
const testEnv = await createRunnerTestEnv({
	backend: 'deno',
})
export const env = testEnv.env
export const pg = testEnv.pg
afterAll(() => testEnv.close())
