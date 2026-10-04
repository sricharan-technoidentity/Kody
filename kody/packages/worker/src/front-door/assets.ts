import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
const contentTypes: Record<string, string> = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain',
}
export function createDiskAssets(directory: string) {
	const root = resolve(directory)
	return {
		async fetch(request: Request) {
			if (!['GET', 'HEAD'].includes(request.method))
				return new Response(null, { status: 404 })
			let name: string
			try {
				name = decodeURIComponent(new URL(request.url).pathname)
			} catch {
				return new Response(null, { status: 400 })
			}
			const path = resolve(root, `.${name}`)
			if (!path.startsWith(`${root}${sep}`))
				return new Response(null, { status: 404 })
			try {
				const resolved = await realpath(path)
				if (!resolved.startsWith(`${root}${sep}`))
					return new Response(null, { status: 404 })
				if (!(await stat(resolved)).isFile())
					return new Response(null, { status: 404 })
				return new Response(
					request.method === 'HEAD' ? null : await readFile(resolved),
					{
						headers: {
							'Content-Type':
								contentTypes[extname(path)] ?? 'application/octet-stream',
						},
					},
				)
			} catch (error) {
				if (
					['ENOENT', 'ENOTDIR'].includes(
						(error as { code?: string }).code ?? '',
					)
				)
					return new Response(null, { status: 404 })
				throw error
			}
		},
	}
}
