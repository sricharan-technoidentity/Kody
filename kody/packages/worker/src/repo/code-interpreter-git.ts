import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'
import { type CodeInterpreterSession } from './code-interpreter-workspace.ts'

type Base = { dir?: string }
type Auth = {
	url?: string
	username?: string
	password?: string
	onAuth?: () => { username: string; password?: string }
	corsProxy?: string
	depth?: number
}
/** Git credentials stay in this activity bridge; the interpreter sees files only. */
export function createGit(
	filesystem: CodeInterpreterSession['filesystem'],
	directory: string,
) {
	const fs = createIsomorphicGitFs(filesystem)
	const base = (input: Base) => ({ fs, dir: input.dir ?? directory })
	return {
		async clone(
			input: Base & Auth & { branch?: string; singleBranch?: boolean },
		) {
			const { git, http } = await loadIsomorphicGit()
			return git.clone({
				...base(input),
				http,
				url: input.url!,
				ref: input.branch,
				singleBranch: input.singleBranch,
				depth: input.depth,
				corsProxy: input.corsProxy,
				onAuth:
					input.onAuth ??
					(() => ({
						username: input.username ?? '',
						password: input.password,
					})),
			})
		},
		async init(input: Base & { defaultBranch?: string }) {
			const { git } = await loadIsomorphicGit()
			return git.init({ ...base(input), defaultBranch: input.defaultBranch })
		},
		async remote(
			input: Base & {
				list?: boolean
				add?: { name: string; url: string }
				remove?: string
			},
		) {
			const { git } = await loadIsomorphicGit()
			if (input.remove)
				return git.deleteRemote({ ...base(input), remote: input.remove })
			if (input.add)
				return git.addRemote({
					...base(input),
					remote: input.add.name,
					url: input.add.url,
				})
			return git.listRemotes(base(input))
		},
		async status(input: Base) {
			const { git } = await loadIsomorphicGit()
			return (await git.statusMatrix(base(input))).map(
				([filepath, head, workdir, stage]) => ({
					filepath,
					status:
						head === workdir && workdir === stage
							? 'unmodified'
							: workdir === 0
								? 'deleted'
								: head === 0
									? 'added'
									: 'modified',
				}),
			)
		},
		async add(input: Base & { filepath: string }) {
			const { git } = await loadIsomorphicGit()
			if (input.filepath !== '.')
				return git.add({ ...base(input), filepath: input.filepath })
			for (const [filepath, , workdir] of await git.statusMatrix(base(input))) {
				if (workdir === 0) await git.remove({ ...base(input), filepath })
				else await git.add({ ...base(input), filepath })
			}
		},
		async rm(input: Base & { filepath: string }) {
			const { git } = await loadIsomorphicGit()
			return git.remove({ ...base(input), filepath: input.filepath })
		},
		async commit(
			input: Base & {
				message: string
				author: { name: string; email: string }
			},
		) {
			const { git } = await loadIsomorphicGit()
			return {
				oid: await git.commit({
					...base(input),
					message: input.message,
					author: input.author,
				}),
				message: input.message,
			}
		},
		async log(input: Base & { depth?: number }) {
			const { git } = await loadIsomorphicGit()
			return git.log({ ...base(input), depth: input.depth })
		},
		async checkout(
			input: Base & {
				ref?: string
				branch?: string
				create?: boolean
				force?: boolean
			},
		) {
			const { git } = await loadIsomorphicGit()
			if (input.branch || input.create)
				await git.branch({ ...base(input), ref: input.branch ?? input.ref! })
			return git.checkout({
				...base(input),
				ref: input.branch ?? input.ref!,
				force: input.force,
			})
		},
		async branch(input: Base) {
			const { git } = await loadIsomorphicGit()
			return {
				branches: await git.listBranches(base(input)),
				current: await git.currentBranch(base(input)),
			}
		},
		async fetch(input: Base & Auth & { remote?: string; ref?: string }) {
			const { git, http } = await loadIsomorphicGit()
			return git.fetch({
				...base(input),
				http,
				remote: input.remote,
				ref: input.ref,
				url: input.url,
				onAuth:
					input.onAuth ??
					(() => ({
						username: input.username ?? '',
						password: input.password,
					})),
			})
		},
		async pull(
			input: Base &
				Auth & {
					remote?: string
					ref?: string
					author?: { name: string; email: string }
				},
		) {
			const { git, http } = await loadIsomorphicGit()
			await git.pull({
				...base(input),
				http,
				remote: input.remote,
				ref: input.ref,
				author: input.author,
				onAuth:
					input.onAuth ??
					(() => ({
						username: input.username ?? '',
						password: input.password,
					})),
			})
			return { pulled: true }
		},
		async push(
			input: Base &
				Auth & {
					remote?: string
					ref?: string
					remoteRef?: string
					force?: boolean
				},
		) {
			const { git, http } = await loadIsomorphicGit()
			return git.push({
				...base(input),
				http,
				remote: input.remote,
				ref: input.ref,
				remoteRef: input.remoteRef,
				force: input.force,
				onAuth:
					input.onAuth ??
					(() => ({
						username: input.username ?? '',
						password: input.password,
					})),
			})
		},
		async diff(input: Base) {
			const { git } = await loadIsomorphicGit()
			const changes = []
			for (const [filepath, head, workdir] of await git.statusMatrix(
				base(input),
			)) {
				if (head === workdir) continue
				let oldContent: string | null = null
				if (head)
					oldContent = new TextDecoder().decode(
						(
							await git.readBlob({
								...base(input),
								oid: await git.resolveRef({ ...base(input), ref: 'HEAD' }),
								filepath,
							})
						).blob,
					)
				const newContent = workdir
					? await filesystem.readFile(`${input.dir ?? directory}/${filepath}`)
					: null
				changes.push({ filepath, oldContent, newContent })
			}
			return changes
		},
	}
}
