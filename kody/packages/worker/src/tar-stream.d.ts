declare module 'tar-stream' {
	import { type Readable, type Writable } from 'node:stream'
	export function extract(): Writable & {
		on(
			event: 'entry',
			callback: (
				header: { type: string; name: string; size: number },
				stream: Readable,
				next: () => void,
			) => void,
		): Writable
	}
	export function pack(): Readable & {
		entry(
			header: { name: string; type?: string; linkname?: string },
			body?: string,
		): void
		finalize(): void
	}
}
