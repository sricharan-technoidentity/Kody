import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from './pg-database.ts'

test('ordinary account connections cannot read or mutate foreign billing and codemod rows', async () => {
	await using fixture = await createTestDb({ userId: 'alice' })
	await fixture.pg.exec(`
		INSERT INTO credit_wallets (user_id, created_at, updated_at) VALUES ('bob', 'now', 'now');
		INSERT INTO credit_ledger_entries (id, user_id, kind, amount_micro_usd, created_at) VALUES ('entry', 'bob', 'top_up', 1, 'now');
		INSERT INTO credit_debit_progress VALUES ('bob', '2026-10', 'dynamic_worker_day', 1, 'now');
		INSERT INTO referrals (referrer_stable_user_id, referee_stable_user_id, created_at) VALUES ('bob', 'charlie', 'now');
		INSERT INTO package_codemod_runs (id, codemod_id, mode, scope_user_id, initiated_by_user_id, status, created_at, updated_at) VALUES ('run', 'change', 'apply', 'bob', 'bob', 'done', 'now', 'now');
		INSERT INTO package_codemod_run_items (id, run_id, user_id, package_id, kody_id, status, created_at, updated_at) VALUES ('item', 'run', 'bob', 'package', '@bob/package', 'done', 'now', 'now');
	`)
	for (const table of [
		'credit_wallets',
		'credit_ledger_entries',
		'credit_debit_progress',
		'referrals',
		'package_codemod_runs',
		'package_codemod_run_items',
	]) {
		expect(
			(await fixture.db.prepare(`SELECT * FROM ${table}`).all()).results,
			table,
		).toEqual([])
		expect(
			(await fixture.reader.prepare(`SELECT * FROM ${table}`).all()).results,
			table,
		).toEqual([])
		expect(
			(await fixture.db.prepare(`DELETE FROM ${table}`).run()).meta.changes,
			table,
		).toBe(0)
	}
	await expect(
		fixture.db
			.prepare(
				"INSERT INTO credit_wallets (user_id, created_at, updated_at) VALUES ('charlie', 'now', 'now')",
			)
			.run(),
	).rejects.toThrow(/row-level security/)
	await expect(
		fixture.reader
			.prepare("DELETE FROM credit_wallets WHERE user_id = 'bob'")
			.run(),
	).rejects.toThrow(/read.only|read-only|permission/)
	const operator = createPgDatabase({
		connection: fixture.pg,
		role: 'kody_admin',
	})
	expect(
		await operator
			.prepare('SELECT count(*) AS count FROM credit_wallets')
			.first(),
	).toEqual({ count: 1 })
	await operator
		.prepare('UPDATE credit_wallets SET balance_micro_usd = 7')
		.run()
	expect(
		await fixture
			.forUser('bob')
			.db.prepare('SELECT balance_micro_usd FROM credit_wallets')
			.first(),
	).toEqual({ balance_micro_usd: 7 })
	await expect(
		operator.prepare('DELETE FROM credit_wallets').run(),
	).rejects.toThrow(/permission denied/)
	await expect(
		operator.prepare('SELECT * FROM secret_entries').all(),
	).rejects.toThrow(/permission denied/)
	expect(
		await operator
			.prepare(
				'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
			)
			.first(),
	).toEqual({ rolsuper: false, rolbypassrls: false })
})
