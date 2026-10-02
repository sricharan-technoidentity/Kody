const uniqueIndexFieldNames: Record<string, string> = {
	idx_users_stable_user_id: 'stable_user_id',
	idx_user_email_claims_active_email: 'email',
}

export function getUniqueConstraintField(error: unknown) {
	let currentError = error
	while (currentError instanceof Error) {
		const diagnostic = currentError as Error & {
			code?: string
			detail?: string
			constraint?: string
			table?: string
		}
		if (diagnostic.code === '23505') {
			const column = /Key \(([a-z0-9_]+)\)=/i.exec(diagnostic.detail ?? '')?.[1]
			if (column) return column.toLowerCase()
			const { constraint, table } = diagnostic
			if (constraint) {
				// RLS hides the detail from callers who cannot see the other row;
				// PostgreSQL's default `<table>_<column>_key` name still names it.
				if (
					table &&
					constraint.startsWith(`${table}_`) &&
					constraint.endsWith('_key')
				)
					return constraint.slice(table.length + 1, -'_key'.length)
				return uniqueIndexFieldNames[constraint] ?? constraint
			}
		}

		const tableColumnMatch =
			/unique constraint failed:\s*[^.]+\.([a-z0-9_]+)/i.exec(
				currentError.message,
			)
		if (tableColumnMatch?.[1]) {
			return tableColumnMatch[1].toLowerCase()
		}
		const indexMatch = /unique constraint failed:\s*(idx_[a-z0-9_]+)/i.exec(
			currentError.message,
		)
		const indexName = indexMatch?.[1]?.toLowerCase()
		if (indexName) {
			return uniqueIndexFieldNames[indexName] ?? indexName
		}
		currentError = currentError.cause
	}
	return null
}
