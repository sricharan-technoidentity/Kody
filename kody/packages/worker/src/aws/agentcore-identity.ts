import {
	BedrockAgentCoreClient,
	GetResourceOauth2TokenCommand,
	GetWorkloadAccessTokenForUserIdCommand,
	type GetResourceOauth2TokenCommandOutput,
	type GetWorkloadAccessTokenForUserIdCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore'

export type AgentCoreIdentitySend = (
	command:
		| GetWorkloadAccessTokenForUserIdCommand
		| GetResourceOauth2TokenCommand,
) => Promise<
	Partial<
		GetWorkloadAccessTokenForUserIdCommandOutput &
			GetResourceOauth2TokenCommandOutput
	>
>

/**
 * AgentCore Identity token vault client. Construct it only in the egress
 * proxy and MCP-client activities; IAM grants token access to those
 * workloads alone. Returns `undefined` when the user must (re)connect: the
 * vault never starts a consent flow from here.
 */
export function createAgentCoreTokenVault(input: {
	region: string
	workloadName: string
	send?: AgentCoreIdentitySend
}) {
	const client = input.send
		? undefined
		: new BedrockAgentCoreClient({ region: input.region })
	const send: AgentCoreIdentitySend =
		input.send ??
		((command) => client!.send(command as GetResourceOauth2TokenCommand))
	return {
		async fetch(
			userId: string,
			provider: string,
			scopes: readonly string[] = [],
		): Promise<string | undefined> {
			const { workloadAccessToken } = await send(
				new GetWorkloadAccessTokenForUserIdCommand({
					workloadName: input.workloadName,
					userId,
				}),
			)
			if (!workloadAccessToken) {
				throw new Error('AgentCore Identity returned no workload token.')
			}
			const { accessToken } = await send(
				new GetResourceOauth2TokenCommand({
					workloadIdentityToken: workloadAccessToken,
					resourceCredentialProviderName: provider,
					scopes: [...scopes],
					oauth2Flow: 'USER_FEDERATION',
					forceAuthentication: false,
				}),
			)
			return accessToken
		},
	}
}
