import { defineConfig, devices } from '@playwright/test'

const hasExplicitBaseUrl = Boolean(process.env.PLAYWRIGHT_BASE_URL)
const defaultPlaywrightPort = '3847'
const baseURL =
	process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${defaultPlaywrightPort}`
const webServerCommand = `npm run e2e:web-server -- --port ${defaultPlaywrightPort}`

export default defineConfig({
	testDir: './e2e',
	testMatch: [
		'**/smoke.spec.ts',
		'**/signup-verify-connect.spec.ts',
		'**/account-navigation.spec.ts',
	],
	// Vitest node-unit helpers live beside Playwright specs as
	// `*.node.test.ts`; do not treat them as Playwright tests.
	testIgnore: ['**/*.node.test.ts'],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: process.env.CI ? 60_000 : 30_000,
	// The POC shares one Node/PGlite fixture across these three journeys.
	workers: 1,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL,
		trace: 'on-first-retry',
	},
	webServer: {
		command: webServerCommand,
		url: `${baseURL}/health`,
		// Readiness includes the Temporal test server and registered activities.
		timeout: process.env.CI ? 180_000 : 90_000,
		reuseExistingServer: hasExplicitBaseUrl,
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
})
