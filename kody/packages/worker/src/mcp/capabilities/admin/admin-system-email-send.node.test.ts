import {
	createTestPg,
	createTestAuditPg,
} from '#worker/test-support/aws/test-pg.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
	sendSystemEmail: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/email/system-outbound.ts', () => ({
	maxSystemOutboundRecipients: 5,
	sendSystemEmail: mockModule.sendSystemEmail,
}))

const { adminSystemEmailSendCapability } =
	await import('./admin-system-email-send.ts')

async function createAdminCtx() {
	const auditSqlite = await createTestAuditPg()

	return {
		env: {
			AUDIT_DB: createPgDatabase({
				connection: auditSqlite,
				role: 'kody_audit_writer',
			}),
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

test('adminSystemEmailSend is admin-gated, validates input, and audits a redacted send', async () => {
	expect(adminSystemEmailSendCapability.requiredRole).toBe('admin')
	expect(adminSystemEmailSendCapability.readOnly).toBe(false)
	const ctx = await createAdminCtx()
	mockModule.sendSystemEmail.mockClear()

	await expect(
		adminSystemEmailSendCapability.handler(
			{ to: 'reporter@example.com', subject: 'No body' },
			ctx,
		),
	).rejects.toThrow(/text/iu)

	await expect(
		adminSystemEmailSendCapability.handler(
			{
				to: Array.from({ length: 6 }, (_, index) => `r${index}@example.com`),
				subject: 'Too many',
				text: 'Body',
			},
			ctx,
		),
	).rejects.toThrow('Invalid input for capability "adminSystemEmailSend"')
	expect(mockModule.sendSystemEmail).not.toHaveBeenCalled()

	mockModule.sendSystemEmail.mockResolvedValue({
		from: 'support@heykody.dev',
		to: ['reporter@example.com'],
		providerMessageId: 'provider-1',
	})

	const result = await adminSystemEmailSendCapability.handler(
		{
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			from_local: 'support',
		},
		ctx,
	)

	expect(result).toEqual({
		from: 'support@heykody.dev',
		to: ['reporter@example.com'],
		provider_message_id: 'provider-1',
	})
	expect(mockModule.sendSystemEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			localPart: 'support',
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			html: null,
			replyTo: null,
			waitUntil: undefined,
		}),
	)
	const auditCall = mockModule.logAuditEvent.mock.calls.at(-1)?.[0] as
		| { action: string; result: string; reason: string }
		| undefined
	expect(auditCall?.action).toBe('adminSystemEmailSend')
	expect(auditCall?.result).toBe('success')
	expect(auditCall?.reason).toContain('from=support@heykody.dev')
	// Recipients are redacted in audit rows, never stored in the clear.
	expect(auditCall?.reason).not.toContain('reporter@example.com')
})
