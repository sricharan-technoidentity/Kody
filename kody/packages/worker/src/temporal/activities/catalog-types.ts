/** Catalog payloads contain owner ids and object references, never mail bytes or tokens. */
export type AccountDeleteInput = { userId: string; dbUserId: number }
export type MailObjectInput = {
	userId: string
	messageId: string
	objectKey: string
}
export type InboundEmailInput = MailObjectInput & { from: string; to: string }
export type McpConnectionInput = {
	userId: string
	serverId: string
	callbackUrl: string
}
export type CatalogActivities = {
	deleteAccount(input: AccountDeleteInput): Promise<unknown>
	receiveEmail(input: InboundEmailInput): Promise<{ rejected: string | null }>
	sendEmail(
		input: MailObjectInput,
	): Promise<{ messageId: string; status: string }>
	maintainMcpConnection(
		input: McpConnectionInput,
	): Promise<{ connected: boolean }>
	disconnectMcpConnection(input: McpConnectionInput): Promise<void>
}
