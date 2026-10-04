/** Escape a literal substring for PostgreSQL LIKE with an explicit escape clause. */
export function escapeLikePattern(value: string) {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function containsLikePattern(
	value: string,
	options: { escape?: boolean } = {},
) {
	return `%${options.escape === false ? value : escapeLikePattern(value)}%`
}
