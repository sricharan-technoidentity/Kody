import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Downloads only the official CLI. An existing executable bypasses all network access. */
export async function prepareTemporal(
	executable = process.env.KODY_TEMPORAL_EXECUTABLE,
) {
	const cached = resolve('node_modules/.cache/kody-demo/temporal')
	const path = executable ? resolve(executable) : cached
	try {
		await access(path, constants.X_OK)
		await exec(path, ['--version'], { timeout: 10000 })
		return path
	} catch (error) {
		if (executable)
			throw new Error(`Temporal executable is unavailable: ${path}`, {
				cause: error,
			})
	}
	if (!['linux', 'darwin'].includes(process.platform))
		throw new Error(
			'Set KODY_TEMPORAL_EXECUTABLE to an existing Temporal CLI on this platform.',
		)
	const arch =
		process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null
	if (!arch)
		throw new Error(`Unsupported Temporal architecture: ${process.arch}`)
	console.info(
		'Preparing Temporal CLI (one-time download from temporal.download).',
	)
	const directory = await mkdtemp(join(tmpdir(), 'kody-demo-download-'))
	try {
		const { stdout } = await exec(
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
				`https://temporal.download/cli/default?arch=${arch}&platform=${process.platform}&sdk-name=sdk-typescript&sdk-version=1.24.0`,
			],
			{ timeout: 65000 },
		)
		const metadata = JSON.parse(stdout) as {
			archiveUrl: string
			fileToExtract: string
		}
		const url = new URL(metadata.archiveUrl)
		if (
			url.protocol !== 'https:' ||
			url.hostname !== 'temporal.download' ||
			metadata.fileToExtract !== 'temporal'
		)
			throw new Error('Unexpected Temporal download metadata.')
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
				'120',
				url.href,
				'--output',
				join(directory, 'cli.tar.gz'),
			],
			{ timeout: 125000 },
		)
		await exec('tar', [
			'-xzf',
			join(directory, 'cli.tar.gz'),
			'-C',
			directory,
			'temporal',
		])
		await chmod(join(directory, 'temporal'), 0o700)
		await exec(join(directory, 'temporal'), ['--version'], { timeout: 10000 })
		await mkdir(resolve('node_modules/.cache/kody-demo'), { recursive: true })
		await rename(join(directory, 'temporal'), cached)
		return cached
	} catch (error) {
		throw new Error(
			'Temporal preparation failed. Set KODY_TEMPORAL_EXECUTABLE to an existing CLI in restricted environments.',
			{ cause: error },
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}
