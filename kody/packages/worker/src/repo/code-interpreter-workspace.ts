export type WorkspaceTreeNode = {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<WorkspaceTreeNode>
}
import { matchesGlob } from 'node:path'
import { type createIsomorphicGitFs } from './isomorphic-git-fs.ts'
import { type RepoSessionContentEditPlan } from './plan-repo-session-content-edits.ts'

/** File API provided by an owner-scoped AgentCore Code Interpreter session. */
export type CodeInterpreterSession = {
	filesystem: Parameters<typeof createIsomorphicGitFs>[0]
	storage: {
		get<T>(key: string): Promise<T | undefined>
		put(key: string, value: unknown): Promise<void>
		deleteAll(): Promise<void>
	}
	run(
		check: 'bundle' | 'typecheck' | 'lint',
	): Promise<{ ok: boolean; output: string }>
}

export class Workspace {
	readonly filesystem: CodeInterpreterSession['filesystem']
	constructor(session: CodeInterpreterSession) {
		this.filesystem = session.filesystem
	}
	async exists(path: string) {
		try {
			await this.filesystem.stat(path)
			return true
		} catch (e) {
			if ((e as { code?: string }).code === 'ENOENT') return false
			throw e
		}
	}
	async readFile(path: string) {
		if (!(await this.exists(path))) return null
		return this.filesystem.readFile(path)
	}
	writeFile(path: string, content: string) {
		return this.filesystem.writeFile(path, content)
	}
	writeFileBytes(path: string, content: Uint8Array) {
		return this.filesystem.writeFileBytes(path, content)
	}
	mkdir(path: string, options?: { recursive?: boolean }) {
		return this.filesystem.mkdir(path, options)
	}
	rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
		return this.filesystem.rm(path, options)
	}
	async glob(pattern: string) {
		const entries: Array<{
			path: string
			type: 'file' | 'directory' | 'symlink'
			size: number
		}> = []
		async function walk(
			fs: CodeInterpreterSession['filesystem'],
			root: string,
		): Promise<void> {
			for (const name of await fs.readdir(root)) {
				const path = `${root === '/' ? '' : root}/${name}`
				const stat = await fs.lstat(path)
				if (matchesGlob(path.replace(/^\/+/, ''), pattern.replace(/^\/+/, '')))
					entries.push({ path, type: stat.type, size: stat.size })
				if (stat.type === 'directory') await walk(fs, path)
			}
		}
		await walk(this.filesystem, '/')
		return entries
	}
}
export class WorkspaceFileSystem {
	constructor(workspace: Workspace) {
		return workspace.filesystem
	}
	declare readFile: CodeInterpreterSession['filesystem']['readFile']
	declare readFileBytes: CodeInterpreterSession['filesystem']['readFileBytes']
	declare writeFile: CodeInterpreterSession['filesystem']['writeFile']
	declare writeFileBytes: CodeInterpreterSession['filesystem']['writeFileBytes']
	declare rm: CodeInterpreterSession['filesystem']['rm']
	declare mkdir: CodeInterpreterSession['filesystem']['mkdir']
	declare readdir: CodeInterpreterSession['filesystem']['readdir']
	declare stat: CodeInterpreterSession['filesystem']['stat']
	declare lstat: CodeInterpreterSession['filesystem']['lstat']
	declare readlink: CodeInterpreterSession['filesystem']['readlink']
	declare symlink: CodeInterpreterSession['filesystem']['symlink']
}
export function createWorkspaceStateBackend(workspace: Workspace) {
	return {
		async applyEditPlan(
			plan: RepoSessionContentEditPlan,
			options: { dryRun?: boolean; rollbackOnError?: boolean } = {},
		) {
			const previous = new Map<string, string | null>()
			if (!options.dryRun) {
				try {
					for (const edit of plan.edits) {
						if (!edit.changed) continue
						if (!previous.has(edit.path))
							previous.set(edit.path, await workspace.readFile(edit.path))
						await workspace.writeFile(edit.path, edit.content)
					}
				} catch (e) {
					if (options.rollbackOnError !== false)
						for (const [path, content] of previous) {
							if (content === null) await workspace.rm(path, { force: true })
							else await workspace.writeFile(path, content)
						}
					throw e
				}
			}
			return { ...plan, dryRun: options.dryRun ?? false }
		},
		async walkTree(root: string, options: { maxDepth?: number } = {}) {
			async function walk(
				path: string,
				depth: number,
			): Promise<WorkspaceTreeNode> {
				const stat = await workspace.filesystem.lstat(path)
				const node: WorkspaceTreeNode = {
					path,
					name: path.split('/').at(-1) ?? '',
					type: stat.type,
					size: stat.size,
				}
				if (stat.type === 'directory' && depth < (options.maxDepth ?? 100)) {
					node.children = await Promise.all(
						(await workspace.filesystem.readdir(path))
							.filter((name) => name !== '.git')
							.sort()
							.map((name) => walk(`${path}/${name}`, depth + 1)),
					)
				}
				return node
			}
			return walk(root, 0)
		},
	}
}
