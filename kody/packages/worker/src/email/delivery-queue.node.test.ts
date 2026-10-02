import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareEmailDeliveryEvent: vi.fn(),
	applyOutboundEmailAbusePause: vi.fn(),
	dispatchEmailDeliverySubscriptionEvents: vi.fn(),
	notifyAdminsOfVerificationDeliveryFailure: vi.fn(),
}))

vi.mock('./delivery-events.ts', () => ({
	processCloudflareEmailDeliveryEvent:
		mocks.processCloudflareEmailDeliveryEvent,
}))

vi.mock('./outbound-abuse.ts', () => ({
	applyOutboundEmailAbusePause: mocks.applyOutboundEmailAbusePause,
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchEmailDeliverySubscriptionEvents:
		mocks.dispatchEmailDeliverySubscriptionEvents,
}))

vi.mock('./verification-delivery-notify.ts', () => ({
	notifyAdminsOfVerificationDeliveryFailure:
		mocks.notifyAdminsOfVerificationDeliveryFailure,
}))

const { processEmailDeliveryMessage } = await import('./delivery-queue.ts')

test('delivery events handle terminal outcomes without a D1-to-Mailbox graph mirror', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const providerEvent = {
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-1', userId: 'user-1' }
	mocks.processCloudflareEmailDeliveryEvent
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'duplicate',
			providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'invalid',
			providerEvent: null,
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'stale',
			providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'unmatched',
			providerEvent,
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'recorded_transactional',
			providerEvent,
			event: {
				userId: 9,
				kind: 'email_verification',
				recipient: 'blocked@example.com',
				status: 'bounced',
				class: 'sender_block',
				alreadyTerminal: false,
			},
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'recorded_transactional',
			providerEvent,
			event: {
				userId: 9,
				kind: 'email_destination_verification',
				recipient: 'pager@example.com',
				status: 'bounced',
				class: 'other',
				alreadyTerminal: false,
			},
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
			message: storedMessage,
		})
	mocks.applyOutboundEmailAbusePause.mockResolvedValue(undefined)
	mocks.dispatchEmailDeliverySubscriptionEvents
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(new Error('transient subscription failure'))
	const waitUntilPromises: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		waitUntilPromises.push(promise)
	}
	const prepare = vi.fn()
	const env = { APP_DB: { prepare } } as unknown as Env
	const outcomes = []
	for (let index = 0; index < 8; index += 1) {
		outcomes.push(await processEmailDeliveryMessage({ index }, env, waitUntil))
	}

	expect(outcomes).toEqual([
		'ack', // recorded
		'ack', // duplicate
		'ack', // invalid
		'ack', // stale
		'retry', // unmatched
		'ack', // verification bounce
		'ack', // destination verification bounce
		'retry', // subscription dispatch failure
	])
	expect(mocks.notifyAdminsOfVerificationDeliveryFailure).toHaveBeenCalledOnce()
	expect(mocks.notifyAdminsOfVerificationDeliveryFailure).toHaveBeenCalledWith({
		env: expect.anything(),
		event: expect.objectContaining({
			status: 'bounced',
			class: 'sender_block',
			kind: 'email_verification',
		}),
		waitUntil: expect.any(Function),
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-destination-verification-delivery',
		{
			status: 'bounced',
			class: 'other',
			kind: 'email_destination_verification',
		},
	)
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledTimes(3)
	expect(waitUntilPromises).toHaveLength(0)
	expect(prepare).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith('email-delivery-event-unmatched', {
		providerMessageId: 'provider-1',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'email-delivery-event-processing-failed',
		expect.any(Error),
	)
})
