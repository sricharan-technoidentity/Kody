import { afterAll } from 'vitest'
import { createRunnerTestEnv } from './runner.ts'

// One isolated compatibility environment per test file; authored modules run in real workerd.
const testEnv = await createRunnerTestEnv()
export const env = testEnv.env
export const pg = testEnv.pg
afterAll(() => testEnv.close())
