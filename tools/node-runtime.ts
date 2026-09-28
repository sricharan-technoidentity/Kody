import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveLocalBinary(binaryName: string) {
	const localBinaryPath = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
	)

	return existsSync(localBinaryPath) ? localBinaryPath : binaryName
}

export type CommandInvocation = {
	command: string
	argsPrefix: Array<string>
}

export function resolveWranglerInvocation(
	root = process.cwd(),
): CommandInvocation {
	const wranglerScript = path.join(
		root,
		'node_modules',
		'wrangler',
		'bin',
		'wrangler.js',
	)
	return existsSync(wranglerScript)
		? { command: process.execPath, argsPrefix: [wranglerScript] }
		: { command: resolveLocalBinary('wrangler'), argsPrefix: [] }
}

export function resolveViteInvocation(root = process.cwd()): CommandInvocation {
	const viteScript = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
	return existsSync(viteScript)
		? { command: process.execPath, argsPrefix: [viteScript] }
		: { command: resolveLocalBinary('vite'), argsPrefix: [] }
}

export function resolveNpmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function resolveNpmInvocation(env: NodeJS.ProcessEnv = process.env): {
	command: string
	argsPrefix: Array<string>
} {
	const npmExecPath =
		process.platform === 'win32' ? env.npm_execpath?.trim() : undefined
	return npmExecPath
		? {
				command: env.npm_node_execpath?.trim() || process.execPath,
				argsPrefix: [npmExecPath],
			}
		: { command: resolveNpmCommand(), argsPrefix: [] }
}

export function isExecutedDirectly(importMetaUrl: string) {
	const entryPoint = process.argv[1]
	if (!entryPoint) {
		return false
	}

	return pathToFileURL(path.resolve(entryPoint)).href === importMetaUrl
}
