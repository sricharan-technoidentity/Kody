import { test, expect, type Page } from '@playwright/test'
import { runDemoScenario } from '../tools/demo/scenario.ts'

async function login(page: Page, email: string) {
	await page.goto('/login')
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true', {
		timeout: 30000,
	})
	await page.getByLabel('Email', { exact: true }).fill(email)
	await page.getByLabel('Password', { exact: true }).fill('demo-password-123')
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 })
}

test('Alice can present the combined story and Bob cannot see her private memory or app', async ({
	page,
	browser,
}) => {
	await login(page, 'alice@example.invalid')
	await page.goto('/account/memories')
	await expect(
		page.getByRole('heading', { name: 'Memories', level: 1 }),
	).toBeVisible()
	const result = await runDemoScenario()
	await page.reload()
	await expect(
		page.getByText(`Approved demo memory ${result.run}`, { exact: true }),
	).toBeVisible()
	await page.goto('/@alice/packages/report')
	await expect(
		page.getByText(`POC report ${result.run}`, { exact: true }),
	).toBeVisible()
	const bobContext = await browser.newContext()
	try {
		const bob = await bobContext.newPage()
		await login(bob, 'bob@example.invalid')
		await bob.goto('/account/memories')
		await expect(
			bob.getByRole('heading', { name: 'Memories', level: 1 }),
		).toBeVisible()
		await expect(
			bob.getByText(`Approved demo memory ${result.run}`, { exact: true }),
		).toHaveCount(0)
		const denied = await bob.goto('/@alice/packages/report')
		expect(denied?.status()).toBe(404)
	} finally {
		await bobContext.close()
	}
})
