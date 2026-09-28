import { defineConfig } from 'vitest/config'
import nodeConfig from './vitest.node.config.ts'

export default defineConfig({
	...nodeConfig,
	test: {
		...nodeConfig.test,
		name: 'temporal',
		include: [
			'packages/shared/src/temporal/**/*.node.test.ts',
			'packages/worker/src/temporal/**/*.node.test.ts',
			'packages/worker/src/package-runtime/package-workflows-temporal.node.test.ts',
			'packages/worker/src/package-runtime/temporal-workflow-artifacts.node.test.ts',
			'packages/jobs-worker/src/schedule-outbox.node.test.ts',
			'packages/jobs-worker/src/temporal-occurrences.node.test.ts',
			'packages/temporal-worker/test/**/*.node.test.ts',
			'packages/temporal-gateway/src/**/*.node.test.ts',
		],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
