import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	TransactWriteItemsCommand,
	UpdateItemCommand,
	type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { type DynamoCommand, type DynamoOutput } from '#worker/aws/dynamo.ts'
import { runsByStartedIndex } from '#worker/aws/dynamo-runs.ts'

type Item = Record<string, AttributeValue>
type Names = Record<string, string> | undefined
type Values = Record<string, AttributeValue> | undefined
type Index = { hash: string; range: string }

/**
 * In-memory DynamoDB that interprets the commands the `aws/dynamo-*`
 * adapters send (key schema `pk`/`sk`), so caller tests run the production
 * adapters unchanged. Conditions, update expressions, queries (including
 * GSIs), `Limit` paging and `TransactWriteItems` follow DynamoDB semantics;
 * TTL is lazy as in DynamoDB (adapters hide expired items themselves).
 */
// ponytail: expression subset the adapters use (no nested paths, lists or sets); grow it with the adapters or switch to DynamoDB Local.
export function createFakeDynamo(
	options: { indexes?: Record<string, Index> } = {},
) {
	const indexes = {
		'ns-pk': { hash: 'ns', range: 'pk' },
		[runsByStartedIndex]: { hash: 'pk', range: 'startedSk' },
		...options.indexes,
	}
	const tables = new Map<string, Map<string, Item>>()
	const tableOf = (name: string | undefined) => {
		if (!name) throw new Error('TableName is required.')
		let table = tables.get(name)
		if (!table) tables.set(name, (table = new Map()))
		return table
	}
	const keyOf = (key: Item | undefined) => {
		const pk = key?.pk?.S
		const sk = key?.sk?.S
		if (pk === undefined || sk === undefined) {
			throw validation('Key must contain string pk and sk.')
		}
		return `${pk}\0${sk}`
	}

	function conditionFailed(item: Item | undefined, returnOld?: string) {
		return Object.assign(new Error('The conditional request failed'), {
			name: 'ConditionalCheckFailedException',
			...(returnOld === 'ALL_OLD' && item ? { Item: clone(item) } : {}),
		})
	}

	type Write = {
		table: Map<string, Item>
		key: string
		next: Item | undefined
		current: Item | undefined
		ok: boolean
	}

	function planPut(input: PutItemCommand['input']): Write {
		const table = tableOf(input.TableName)
		const key = keyOf(input.Item)
		const current = table.get(key)
		return {
			table,
			key,
			current,
			next: clone(input.Item!),
			ok: check(input.ConditionExpression, current, input),
		}
	}
	function planDelete(input: DeleteItemCommand['input']): Write {
		const table = tableOf(input.TableName)
		const key = keyOf(input.Key)
		const current = table.get(key)
		return {
			table,
			key,
			current,
			next: undefined,
			ok: check(input.ConditionExpression, current, input),
		}
	}
	function planUpdate(input: UpdateItemCommand['input']): Write {
		const table = tableOf(input.TableName)
		const key = keyOf(input.Key)
		const current = table.get(key)
		const ok = check(input.ConditionExpression, current, input)
		const next = ok
			? applyUpdate(
					{ ...clone(current ?? {}), ...clone(input.Key!) },
					input.UpdateExpression ?? '',
					input.ExpressionAttributeNames,
					input.ExpressionAttributeValues,
				)
			: undefined
		return { table, key, current, next, ok }
	}
	const commit = (write: Write) =>
		write.next
			? write.table.set(write.key, write.next)
			: write.table.delete(write.key)

	function query(input: QueryCommand['input']): DynamoOutput {
		const index = input.IndexName ? indexes[input.IndexName] : undefined
		if (input.IndexName && !index) {
			throw validation(`Unknown index ${input.IndexName}.`)
		}
		const range = index?.range ?? 'sk'
		const hash = index?.hash ?? 'pk'
		const order = (a: Item, b: Item) =>
			compare(a[range], b[range]) || compare(a.pk, b.pk) || compare(a.sk, b.sk)
		const forward = input.ScanIndexForward !== false
		let candidates = [...tableOf(input.TableName).values()]
			.filter((item) => item[hash] && item[range])
			.filter((item) =>
				evaluate(input.KeyConditionExpression ?? '', item, input),
			)
			.sort((a, b) => (forward ? order(a, b) : order(b, a)))
		if (input.ExclusiveStartKey) {
			const start = input.ExclusiveStartKey
			candidates = candidates.filter((item) =>
				forward ? order(item, start) > 0 : order(item, start) < 0,
			)
		}
		const evaluated =
			input.Limit === undefined ? candidates : candidates.slice(0, input.Limit)
		const items = evaluated.filter(
			(item) =>
				!input.FilterExpression ||
				evaluate(input.FilterExpression, item, input),
		)
		const last = evaluated.at(-1)
		const truncated =
			input.Limit !== undefined && evaluated.length === input.Limit
		return {
			Items: input.Select === 'COUNT' ? undefined : items.map(clone),
			Count: items.length,
			...(truncated && last
				? {
						LastEvaluatedKey: Object.fromEntries(
							[...new Set(['pk', 'sk', hash, range])].map((name) => [
								name,
								last[name]!,
							]),
						),
					}
				: {}),
		} as DynamoOutput
	}

	async function send(command: DynamoCommand): Promise<DynamoOutput> {
		if (command instanceof GetItemCommand) {
			const item = tableOf(command.input.TableName).get(
				keyOf(command.input.Key),
			)
			return item ? { Item: clone(item) } : {}
		}
		if (command instanceof QueryCommand) return query(command.input)
		if (command instanceof TransactWriteItemsCommand) {
			const writes = (command.input.TransactItems ?? []).map((entry) => {
				if (entry.Put) return planPut(entry.Put)
				if (entry.Delete) return planDelete(entry.Delete)
				if (entry.Update) return planUpdate(entry.Update)
				if (entry.ConditionCheck) {
					const write = planDelete(entry.ConditionCheck)
					return { ...write, next: write.current, ok: write.ok }
				}
				throw validation('Unsupported transaction item.')
			})
			if (new Set(writes.map((write) => write.key)).size !== writes.length) {
				throw validation('Transaction items must target distinct keys.')
			}
			if (writes.some((write) => !write.ok)) {
				throw Object.assign(new Error('Transaction cancelled'), {
					name: 'TransactionCanceledException',
					CancellationReasons: writes.map((write) =>
						write.ok ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' },
					),
				})
			}
			for (const write of writes) {
				if (write.next !== write.current) commit(write)
			}
			return {}
		}
		const write =
			command instanceof PutItemCommand
				? planPut(command.input)
				: command instanceof DeleteItemCommand
					? planDelete(command.input)
					: command instanceof UpdateItemCommand
						? planUpdate(command.input)
						: undefined
		if (!write) throw validation('Unsupported DynamoDB command.')
		if (!write.ok) {
			throw conditionFailed(
				write.current,
				(command.input as { ReturnValuesOnConditionCheckFailure?: string })
					.ReturnValuesOnConditionCheckFailure,
			)
		}
		commit(write)
		const returnValues = (command.input as { ReturnValues?: string })
			.ReturnValues
		if (returnValues === 'ALL_NEW' && write.next) {
			return { Attributes: clone(write.next) }
		}
		if (returnValues === 'ALL_OLD' && write.current) {
			return { Attributes: clone(write.current) }
		}
		return {}
	}

	return {
		send,
		/** Synchronous seed write (no condition), for fixtures. */
		putItem(tableName: string, item: Item) {
			tableOf(tableName).set(keyOf(item), clone(item))
		},
		/** Snapshot of a table's items, sorted by `pk`, then `sk`. */
		items(tableName: string) {
			return [...tableOf(tableName).values()]
				.map(clone)
				.sort((a, b) => compare(a.pk, b.pk) || compare(a.sk, b.sk))
		},
	}
}

function validation(message: string) {
	return Object.assign(new Error(message), { name: 'ValidationException' })
}

const clone = (item: Item): Item => structuredClone(item)

function scalar(value: AttributeValue | undefined) {
	if (!value) return undefined
	if (value.S !== undefined) return value.S
	if (value.N !== undefined) return Number(value.N)
	if (value.B !== undefined) return Buffer.from(value.B).toString('latin1')
	if (value.BOOL !== undefined) return value.BOOL
	if (value.NULL) return null
	return JSON.stringify(value)
}

/** DynamoDB orders S and B bytewise and N numerically. */
function compare(a: AttributeValue | undefined, b: AttributeValue | undefined) {
	const left = scalar(a)
	const right = scalar(b)
	if (left === right) return 0
	if (left === undefined) return -1
	if (right === undefined) return 1
	if (typeof left === 'number' && typeof right === 'number') {
		return left - right
	}
	return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)))
}

const tokenPattern = /\s*(<>|<=|>=|[=<>(),+\-]|[#:]?[A-Za-z_][A-Za-z0-9_]*)/y

function tokenize(expression: string) {
	const tokens: Array<string> = []
	tokenPattern.lastIndex = 0
	while (tokenPattern.lastIndex < expression.length) {
		if (/^\s*$/.test(expression.slice(tokenPattern.lastIndex))) break
		const match = tokenPattern.exec(expression)
		if (!match) throw validation(`Cannot parse expression: ${expression}`)
		tokens.push(match[1]!)
	}
	return tokens
}

type Context = {
	ExpressionAttributeNames?: Names
	ExpressionAttributeValues?: Values
}

function resolver(context: Context) {
	return {
		name(token: string) {
			if (!token.startsWith('#')) return token
			const name = context.ExpressionAttributeNames?.[token]
			if (name === undefined) throw validation(`Undefined name ${token}.`)
			return name
		},
		value(token: string) {
			const value = context.ExpressionAttributeValues?.[token]
			if (value === undefined) throw validation(`Undefined value ${token}.`)
			return value
		},
	}
}

function check(
	expression: string | undefined,
	item: Item | undefined,
	context: Context,
) {
	return !expression || evaluate(expression, item ?? {}, context)
}

function evaluate(expression: string, item: Item, context: Context): boolean {
	const tokens = tokenize(expression)
	const { name, value } = resolver(context)
	let position = 0
	const peek = () => tokens[position]
	const next = () => tokens[position++]
	const expect = (token: string) => {
		if (next() !== token) throw validation(`Expected ${token} in ${expression}`)
	}
	const keyword = (word: string) => peek()?.toUpperCase() === word
	const operand = () => {
		const token = next()!
		return token.startsWith(':') ? value(token) : item[name(token)]
	}
	function or(): boolean {
		let result = and()
		while (keyword('OR')) {
			next()
			result = and() || result
		}
		return result
	}
	function and(): boolean {
		let result = not()
		while (keyword('AND')) {
			next()
			result = not() && result
		}
		return result
	}
	function not(): boolean {
		if (keyword('NOT')) {
			next()
			return !not()
		}
		return primary()
	}
	function primary(): boolean {
		if (peek() === '(') {
			next()
			const result = or()
			expect(')')
			return result
		}
		const fn = peek()
		if (
			fn === 'attribute_exists' ||
			fn === 'attribute_not_exists' ||
			fn === 'begins_with'
		) {
			next()
			expect('(')
			const path = name(next()!)
			if (fn === 'begins_with') {
				expect(',')
				const prefix = scalar(operand())
				expect(')')
				const current = scalar(item[path])
				return (
					typeof current === 'string' &&
					typeof prefix === 'string' &&
					current.startsWith(prefix)
				)
			}
			expect(')')
			return fn === 'attribute_exists'
				? item[path] !== undefined
				: item[path] === undefined
		}
		const left = operand()
		const operator = next()!
		if (operator.toUpperCase() === 'BETWEEN') {
			const low = operand()
			if (!keyword('AND')) throw validation(`Expected AND in ${expression}`)
			next()
			const high = operand()
			return (
				left !== undefined &&
				compare(left, low) >= 0 &&
				compare(left, high) <= 0
			)
		}
		const right = operand()
		if (left === undefined || right === undefined) return operator === '<>'
		const order = compare(left, right)
		switch (operator) {
			case '=':
				return order === 0
			case '<>':
				return order !== 0
			case '<':
				return order < 0
			case '<=':
				return order <= 0
			case '>':
				return order > 0
			case '>=':
				return order >= 0
		}
		throw validation(`Unsupported operator ${operator}.`)
	}
	const result = or()
	if (position !== tokens.length) {
		throw validation(`Unexpected token ${peek()} in ${expression}`)
	}
	return result
}

function applyUpdate(
	item: Item,
	expression: string,
	names: Names,
	values: Values,
) {
	const tokens = tokenize(expression)
	const { name, value } = resolver({
		ExpressionAttributeNames: names,
		ExpressionAttributeValues: values,
	})
	const sections = new Set(['SET', 'ADD', 'REMOVE'])
	let position = 0
	const next = () => tokens[position++]
	const atEnd = () =>
		position >= tokens.length || sections.has(tokens[position]!.toUpperCase())
	const operand = () => {
		const token = next()!
		if (token === 'if_not_exists') {
			if (next() !== '(') throw validation('Expected ( after if_not_exists.')
			const path = name(next()!)
			if (next() !== ',') throw validation('Expected , in if_not_exists.')
			const fallback = operand()
			if (next() !== ')') throw validation('Expected ) in if_not_exists.')
			return item[path] ?? fallback
		}
		return token.startsWith(':') ? value(token) : item[name(token)]
	}
	const number = (attribute: AttributeValue | undefined) => {
		if (attribute?.N === undefined) throw validation('Expected a number.')
		return Number(attribute.N)
	}
	while (position < tokens.length) {
		const section = next()!.toUpperCase()
		if (!sections.has(section)) throw validation(`Bad update: ${expression}`)
		while (!atEnd()) {
			const path = name(next()!)
			if (section === 'REMOVE') {
				delete item[path]
			} else if (section === 'ADD') {
				const amount = number(operand())
				item[path] = {
					N: String((item[path] ? number(item[path]) : 0) + amount),
				}
			} else {
				if (next() !== '=') throw validation(`Expected = in ${expression}`)
				let result = operand()
				const operator = tokens[position]
				if (operator === '+' || operator === '-') {
					next()
					const right = number(operand())
					result = {
						N: String(
							operator === '+'
								? number(result) + right
								: number(result) - right,
						),
					}
				}
				if (result === undefined)
					throw validation('SET of a missing attribute.')
				item[path] = clone({ value: result }).value!
			}
			if (tokens[position] === ',') next()
		}
	}
	return item
}
