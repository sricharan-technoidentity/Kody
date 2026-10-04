import { type MailboxSql } from './mailbox-sql.ts'
import { writeMailboxDeliveryEventRow } from './mailbox-delivery-events.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	assertMailboxNonEmptyString,
	mailboxUpsertDeliveryEventsMax,
	type MailboxDeliveryEventInput,
	type MailboxUpsertDeliveryEventsResult,
} from './mailbox-types.ts'

/** Normal bounded delivery-event upsert inside the caller's transaction. */
export async function upsertMailboxDeliveryEvents(
	sql: MailboxSql,
	events: Array<MailboxDeliveryEventInput>,
	options: { restore?: true } = {},
): Promise<MailboxUpsertDeliveryEventsResult> {
	if (!Array.isArray(events) || events.length === 0) {
		throw new Error('Mailbox upsertDeliveryEvents events must be non-empty.')
	}
	if (events.length > mailboxUpsertDeliveryEventsMax) {
		throw new Error(
			`Mailbox upsertDeliveryEvents events exceed max of ${mailboxUpsertDeliveryEventsMax}.`,
		)
	}
	const results: MailboxUpsertDeliveryEventsResult['results'] = []
	for (const event of events) {
		const eventId = assertMailboxNonEmptyString(event.id, 'event.id')
		if (
			!options.restore &&
			(await shouldSkipMailboxDeliveryEventWrite(sql, { event }))
		) {
			results.push({ eventId, inserted: false, accepted: false })
			continue
		}
		results.push({
			eventId,
			...(await writeMailboxDeliveryEventRow(sql, event)),
		})
	}
	return { results }
}
