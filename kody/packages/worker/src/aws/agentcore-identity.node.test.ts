import { expect, test } from 'vitest'
import { createAgentCoreTokenVault } from './agentcore-identity.ts'

test('AgentCore token vault exchanges a per-user workload token for the provider token and never starts consent', async () => {
	const calls: Array<{ name: string; input: unknown }> = []
	const outputs = [
		{ workloadAccessToken: 'wat-alice' },
		{ accessToken: 'gho_alice' },
		{ workloadAccessToken: 'wat-alice' },
		{ authorizationUrl: 'https://github.com/login/oauth/authorize?x' },
		{},
	]
	const vault = createAgentCoreTokenVault({
		region: 'us-east-1',
		workloadName: 'kody-egress-test',
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input })
			return outputs.shift() ?? {}
		},
	})
	expect(await vault.fetch('alice', 'github', ['repo'])).toBe('gho_alice')
	expect(await vault.fetch('alice', 'github')).toBeUndefined()
	await expect(vault.fetch('alice', 'github')).rejects.toThrow(
		'no workload token',
	)
	expect(calls.slice(0, 2)).toEqual([
		{
			name: 'GetWorkloadAccessTokenForUserIdCommand',
			input: { workloadName: 'kody-egress-test', userId: 'alice' },
		},
		{
			name: 'GetResourceOauth2TokenCommand',
			input: {
				workloadIdentityToken: 'wat-alice',
				resourceCredentialProviderName: 'github',
				scopes: ['repo'],
				oauth2Flow: 'USER_FEDERATION',
				forceAuthentication: false,
			},
		},
	])
})
