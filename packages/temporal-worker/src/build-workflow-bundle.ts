import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleWorkflowCode } from '@temporalio/worker'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(packageRoot, 'dist/workflow-bundle.js')
const { code } = await bundleWorkflowCode({
	workflowsPath: resolve(packageRoot, 'src/workflows/index.ts'),
})
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, code)
console.log(`Temporal workflow bundle written to ${outputPath}.`)
