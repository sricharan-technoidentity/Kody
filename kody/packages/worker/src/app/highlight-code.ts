import { lexer, type Token, type Tokens } from 'marked'
import { tokenizeSnippets } from '#worker/highlight/tokenize.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
	type HighlightSnippet,
} from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

export type HighlightEnv = object
export type HighlightOptions = { serverTiming?: Array<ServerTimingEntry> }

export async function highlightSnippets(
	_env: HighlightEnv,
	snippets: Array<HighlightSnippet>,
	options?: HighlightOptions,
): Promise<Array<HighlightedCode>> {
	if (snippets.length === 0) return []
	const startedAt = Date.now()
	const results = tokenizeSnippets(snippets)
	options?.serverTiming?.push({
		name: 'highlight',
		durationMs: Date.now() - startedAt,
		desc: 'library',
	})
	return results
}

function walkMarkdownTokens(
	tokens: Array<Token>,
	fences: Array<HighlightSnippet>,
) {
	for (const token of tokens) {
		if (token.type === 'code') {
			const code = token as Tokens.Code
			fences.push({ code: code.text, lang: code.lang })
			continue
		}
		if (token.type === 'list') {
			const list = token as Tokens.List
			for (const item of list.items) {
				if (item.tokens) walkMarkdownTokens(item.tokens, fences)
			}
			continue
		}
		if ('tokens' in token && Array.isArray(token.tokens)) {
			walkMarkdownTokens(token.tokens, fences)
		}
	}
}

export function collectMarkdownFences(
	markdown: string,
): Array<HighlightSnippet> {
	const fences: Array<HighlightSnippet> = []
	walkMarkdownTokens(lexer(markdown), fences)
	return fences
}

export async function highlightMarkdownFences(
	env: HighlightEnv,
	markdown: string,
	options?: HighlightOptions,
): Promise<Array<HighlightedCode>> {
	return highlightSnippets(env, collectMarkdownFences(markdown), options)
}

export async function highlightJsonValue(
	env: HighlightEnv,
	value: unknown,
	options?: HighlightOptions,
): Promise<HighlightedCode> {
	const code = JSON.stringify(value, null, 2) ?? 'null'
	const [result] = await highlightSnippets(
		env,
		[{ code, lang: 'json' }],
		options,
	)
	return result ?? plainHighlightedCode(code, 'json')
}

export function uniqueHighlightSnippets(
	snippets: Array<HighlightSnippet>,
): Array<HighlightSnippet> {
	const seen = new Set<string>()
	const unique: Array<HighlightSnippet> = []
	for (const snippet of snippets) {
		const key = highlightSnippetKey(snippet)
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(snippet)
	}
	return unique
}

export function highlightResultsByKey(
	snippets: Array<HighlightSnippet>,
	results: Array<HighlightedCode>,
): Record<string, HighlightedCode> {
	const map: Record<string, HighlightedCode> = {}
	for (const [index, snippet] of snippets.entries()) {
		const result = results[index]
		if (!result) continue
		map[highlightSnippetKey(snippet)] = result
	}
	return map
}
