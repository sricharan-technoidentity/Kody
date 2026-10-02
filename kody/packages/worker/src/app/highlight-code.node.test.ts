import { expect, test } from 'vitest'
import {
	collectMarkdownFences,
	highlightJsonValue,
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

test('collectMarkdownFences walks top-level and nested code tokens', () => {
	expect(
		collectMarkdownFences(
			['# Title', '', '```ts', 'const x = 1', '```', '', '- item', ''].join(
				'\n',
			),
		),
	).toEqual([{ code: 'const x = 1', lang: 'ts' }])

	expect(
		collectMarkdownFences(
			['> quote', '', '> ```json', '> {"ok": true}', '> ```'].join('\n'),
		),
	).toEqual([{ code: '{"ok": true}', lang: 'json' }])
})

test('highlightSnippets tokenizes directly and keeps timing and key mapping', async () => {
	const snippet = { code: 'const x = 1', lang: 'ts' as const }
	const timing: Array<ServerTimingEntry> = []
	const results = await highlightSnippets({}, [snippet], {
		serverTiming: timing,
	})
	expect(results).toHaveLength(1)
	expect(results[0]).toMatchObject({
		code: snippet.code,
		lang: 'ts',
		plain: false,
	})
	expect(results[0]?.lines.flat().length).toBeGreaterThan(0)
	expect(timing).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'library' }),
	])
	expect(highlightResultsByKey([snippet], results)).toEqual({
		[highlightSnippetKey(snippet)]: results[0],
	})
	expect(
		uniqueHighlightSnippets([snippet, snippet, { code: 'x', lang: 'txt' }]),
	).toEqual([snippet, { code: 'x', lang: 'txt' }])
	expect(
		await highlightSnippets({}, [{ code: 'x', lang: 'unknown' }]),
	).toMatchObject([{ code: 'x', plain: true }])
})

test('highlightMarkdownFences and highlightJsonValue tokenize code', async () => {
	const markdown = await highlightMarkdownFences({}, '```ts\nconst x = 1\n```')
	expect(markdown).toMatchObject([{ code: 'const x = 1', plain: false }])
	const json = await highlightJsonValue({}, { ok: true })
	expect(json).toMatchObject({
		code: '{\n  "ok": true\n}',
		lang: 'json',
		plain: false,
	})
})
