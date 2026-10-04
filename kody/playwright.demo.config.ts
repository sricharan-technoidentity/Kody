import { defineConfig, devices } from '@playwright/test'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3848'
export default defineConfig({
	testDir: './e2e',
	testMatch: ['**/poc-demo.spec.ts'],
	workers: 1,
	retries: 0,
	timeout: 300000,
	reporter: 'list',
	use: { baseURL, trace: 'retain-on-failure' },
	webServer: {
		command: 'npm run demo',
		url: `${baseURL}/health`,
		timeout: 180000,
		reuseExistingServer: Boolean(process.env.PLAYWRIGHT_BASE_URL),
		env: { PORT: '3848' },
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
