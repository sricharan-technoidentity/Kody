> Historical evidence preserved on 2026-10-04. Commands and topology below
> describe the recorded phase, not current demo instructions.

# P8 final sweep

P8 is complete. `CI=1 npm run validate` passes all 14 gates, with **1,128 Node
test files and 3,593 tests passing**, zero failures and zero skips. This is an
isolated Temporal + AgentCore POC. No production migration, deployment, data
copy or cutover has occurred.

Application repositories use the authored `SqlDatabase`, `SqlStatement` and
`SqlResult` contracts. Converted fixtures load the real PostgreSQL baseline and
use explicit owner, reader, audit or operator connections. They dispose their
PGlite databases after each test. The SQLite query fallback and all five named
P8 helpers are retired: `create-d1-from-sqlite`, `apply-all-migrations`,
`d1-retry`, `d1-data-table-adapter` and `d1-like-pattern`.

PostgreSQL retries use SQLSTATE and bounded backoff. Known historical platform
messages remain in a separate telemetry classifier, with existing Sentry
coverage; they cannot trigger PostgreSQL retries. Substring search preserves
long Unicode text and escapes literal wildcard characters. Package graph and
secret-provider resolution obtain an owner connection through the existing
factory after trusted owner/share authority resolution.

The narrowed operator permissions were explicitly approved and applied in
`packages/worker/migrations-pg/0017_billing_and_codemod_operators.sql`. The
[review copy](../../migration/p8-operator-grants.sql) is not loaded separately.
The role has SELECT/INSERT/UPDATE access on the billing/referral/fleet tables,
with no DELETE grants. The regression proves no secret-table access and no
superuser/BYPASSRLS privileges. Ordinary writers/readers retain owner RLS.
Native upserts, `GREATEST` and unique-conflict handling preserve debit progress,
referral expiry and payment/event replay behavior. Discord role synchronization
uses the trusted account's database. Billing fixtures use explicit per-test
factories, without shared hooks. No migration has been applied to a live
database.

`npm run cloudflare:check` enforces the
[exact 255-file allowlist](../../migration/cloudflare-reference-allowlist.json),
including a reason for each file. Its regression test rejects unlisted
references, wildcard exceptions and stale entries. Retained categories include
native workerd package APIs, portable KV/object adapter shapes, frozen
identifiers and billing fields, third-party metadata, historical operator
tooling and archived Workers fixtures. The archived fixtures are excluded from
Node acceptance and are not evidence that target behavior passes. Automatic
approval review rejected retirement of the legacy authenticated PITR endpoint
and Cloudflare analytics collector as potential service-function loss; they
remain documented scope exceptions.

## Verification

- Final `CI=1 npm run validate`: **all 14 gates pass**, including **1,128 Node
  test files / 3,593 tests**, no failures or skips. The Node suite took 1,403.26
  seconds. Typecheck, lint, formatting, Knip, production audit, lockfile,
  migrations, primitives, reference, documentation, Mermaid and slop-ratchet
  gates pass; lint retains repository warnings.
- Ten acceptance files: **12 tests pass**, including standalone local Temporal
  workflow/activity execution and per-user isolation. Native workerd
  compatibility remains part of the Node suite.
- Preserved billing journeys: **34 tests pass** across wallet, Stripe events and
  overlap/idempotency fixtures.
- Four previously contended fixtures: **14 tests pass** in the isolated
  recovery.
- Native SQL retry/owner/data-table recovery batch: **17 tests pass**.
- SQL retry caller batch: **9 tests pass**; package-registry batch: **11 pass**.
- Retired helper inventory and PostgreSQL facade checks: **6 tests pass**.
- Scheduled lane and artifact-rebuild retry fixtures: **10 tests pass** after
  replacing legacy D1 error injection with PostgreSQL deadlock/connection
  errors.
- Ordinary account/operator billing and codemod RLS regression: **1 test
  passes**.
- Reference checker regression: **1 test passes**; all 255 current reference
  files have explicit entries.
- Production dependency audit: **zero vulnerabilities** after the approved
  compatible lockfile update using `npm audit fix --ignore-scripts`. This is the
  production audit scope; the development dependency audit still reports six
  vulnerabilities.

Focused batch counts overlap and must not be added as unique test totals. The
nested Git migration checker and capability-maintenance prerequisites have
regression coverage. The frozen duplicate `planss/execution plan.md` remains
untouched. The [39-comment inventory](../../migration/p8-shortcuts.md) records
remaining POC ceilings; obsolete signup/definer comments are retired.

## Test-count reconciliation

The baseline had **3,626 tests** (3,624 pass, two checkout prerequisite
failures). P1 removed **342 Cloudflare-only tests**, leaving 3,284 tests. Later
phases added native adapter/workflow cases and moved Workers behavior into the
Node suite; the final count must therefore be compared with the phase and
deleted-test logs, not obtained by subtracting P1 deletions alone.

P8 retires **eight legacy mechanics cases** (driver: one, retry: two, session
registry: two, LIKE limits: two, unsubscribe catch-up migration: one) and adds
**five native cases** (SQL retry: three, reference checker: one, operator
isolation: one), for a **net decrease of three tests**. Owner inventory,
substring matching and unsubscribe behavior remain covered by native PostgreSQL
journeys. The P7 snapshot had 3,600 tests, followed by four generated-Wrangler
config case deletions recorded in the log. Subtracting those four and P8's net
three gives **3,593 tests**, matching the final clean full run. Relative to P1,
this is a net increase of 309 tests across the later implementation phases;
relative to the original baseline, it is a net decrease of 33. Both baseline
checkout prerequisites are resolved, without deleting their behavior cases.
