import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const denoVersion = '2.9.7'
export const denoArm64Sha256 =
	'c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf'
const releases: Record<string, { target: string; sha256: string }> = {
	'linux-x64': {
		target: 'x86_64-unknown-linux-gnu',
		sha256: 'c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490',
	},
	'linux-arm64': {
		target: 'aarch64-unknown-linux-gnu',
		sha256: denoArm64Sha256,
	},
	'darwin-x64': {
		target: 'x86_64-apple-darwin',
		sha256: '95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a',
	},
	'darwin-arm64': {
		target: 'aarch64-apple-darwin',
		sha256: '5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c',
	},
}

export async function prepareDeno(
	executable = process.env.KODY_DENO_EXECUTABLE,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted()
	const cached = resolve(
		`node_modules/.cache/kody-demo/deno-${denoVersion}/deno`,
	)
	const path = executable ? resolve(executable) : cached
	const verify = async () => {
		await access(path, constants.X_OK)
		const { stdout } = await exec(path, ['--version'], {
			timeout: 10000,
			signal,
		})
		if (
			stdout.split('\n')[0] !==
			`deno ${denoVersion} (stable, release, ${releases[`${process.platform}-${process.arch}`]?.target})`
		)
			throw new Error(`The Runner requires Deno ${denoVersion}.`)
	}
	try {
		await verify()
		return path
	} catch (error) {
		signal?.throwIfAborted()
		if (executable)
			throw new Error(
				`Deno executable is unavailable or incompatible: ${path}`,
				{ cause: error },
			)
	}
	const release = releases[`${process.platform}-${process.arch}`]
	if (!release)
		throw new Error(
			`Unsupported Deno platform: ${process.platform}-${process.arch}`,
		)
	const directory = await mkdtemp(join(tmpdir(), 'kody-deno-download-'))
	try {
		const archive = join(directory, 'deno.zip')
		await exec(
			'curl',
			[
				'--fail',
				'--silent',
				'--show-error',
				'--location',
				'--connect-timeout',
				'15',
				'--max-time',
				'60',
				`https://github.com/denoland/deno/releases/download/v${denoVersion}/deno-${release.target}.zip`,
				'--output',
				archive,
			],
			{ timeout: 65000, signal },
		)
		if (
			createHash('sha256')
				.update(await readFile(archive))
				.digest('hex') !== release.sha256
		)
			throw new Error('Deno archive checksum mismatch.')
		await exec('unzip', ['-q', archive, 'deno', '-d', directory], {
			signal,
			timeout: 10000,
		})
		await chmod(join(directory, 'deno'), 0o700)
		await mkdir(resolve(cached, '..'), { recursive: true })
		await rename(join(directory, 'deno'), cached)
		await verify()
		return cached
	} catch (error) {
		throw new Error(
			'Deno preparation failed. Set KODY_DENO_EXECUTABLE to the pinned executable in restricted environments.',
			{ cause: error },
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}
