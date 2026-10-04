import { type LocalTestWorkflowEnvironmentOptions } from '@temporalio/testing'

export function temporalServerOptions(
	input: { executable?: string; uiPort?: number } = {},
) {
	if (
		input.uiPort !== undefined &&
		(!Number.isInteger(input.uiPort) ||
			input.uiPort < 1 ||
			input.uiPort > 65535)
	)
		throw new Error('Temporal UI port must be between 1 and 65535.')
	return {
		ip: '127.0.0.1',
		...(input.executable
			? {
					executable: {
						type: 'existing-path' as const,
						path: input.executable,
					},
				}
			: {}),
		...(input.uiPort ? { ui: true, uiPort: input.uiPort } : {}),
	} satisfies LocalTestWorkflowEnvironmentOptions['server']
}
