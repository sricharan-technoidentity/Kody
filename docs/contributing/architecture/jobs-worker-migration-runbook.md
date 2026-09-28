# Jobs worker migration runbook

The active jobs worker owns `JOBS_DB`, the five-minute cron, the scheduled
dispatch queue, and Temporal Schedule reconciliation. The committed
`transferred_classes` entry for `JobManager` is historical production migration
state; the active entrypoint does not export, bind, or call that class.

This page records current ownership and the invariants later deploys must keep.

Operational notes for the dedicated jobs worker (`packages/jobs-worker`, ADR
[0016 — Mono-worker extraction](../decisions/0016-mono-worker-extraction.md)).
Later deploys follow `.github/workflows/deploy.yml`. Do not re-run the Durable
Object transfer or a bounded D1 copy against live production.

## Ownership

| Concern                                               | Owner                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `jobs`, schedule coordination, and archived artifacts | `JOBS_DB` on `kody-jobs`                                           |
| Temporal Schedule outbox reconciliation               | `kody-jobs` → signed Temporal gateway                              |
| Five-minute cron and `kody-scheduled-dispatch` queues | `kody-jobs`                                                        |
| Package execution and platform scheduled lanes        | `kody` (origin); `kody-jobs` calls back through the `HOST` binding |
| Job reads and writes from origin / MCP / dashboards   | `JOBS` service binding (`JobsService`) on origin                   |
| Historical `JobManager` Durable Object namespace      | Migration ledger only; no active binding or export                 |

`APP_DB` has no `jobs` or `archived_job_artifacts` tables. The schema change is
`packages/worker/migrations/0010-drop-jobs-tables.sql`. Live authority is
`JOBS_DB`. Do not query those names on `APP_DB`, do not copy them "one more
time," and do not treat 0010 as a waiting follow-up.

## Invariants

- Do not add another `transferred_classes` row for `JobManager`. The `v1`
  transfer is part of the applied production migration history
  (`packages/jobs-worker/wrangler.jsonc`,
  `{ from: "JobManager", from_script: "kody-production", to: "JobManager" }`).
- This local Temporal change does not add a production `deleted_classes`
  migration. Any later remote deletion requires explicit production scope,
  reviewed deploy ordering, and the deploy-guardrail allowlist.
- Do not recreate or bind `JobManager` on origin or in local worker configs.
- Service bindings are by deployed worker name (wrangler appends the
  environment, so the production main worker script is `kody-production`):
  origin reaches the jobs worker through `JOBS` (`JobsService`) and `kody-jobs`
  calls back through `HOST` (`JobsHost`). The jobs worker must exist before a
  main-worker deploy that declares the `JOBS` binding can validate, which is why
  `.github/workflows/deploy.yml` deploys the jobs worker first when jobs sources
  change.
- Shared D1 besides `JOBS_DB` is unchanged: jobs data does not live on `APP_DB`.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not pause job writes, export `APP_DB`, or apply a jobs-table drop by hand.

When jobs sources change, the workflow deploys `kody-jobs` before origin so the
`JOBS` binding validates. That order is binding hygiene. It does not re-apply
the `v1` transfer and it does not copy rows.

Remix/blog/UI-only uploads skip jobs.

Verify cron ticks (jobs-worker logs show `scheduled` invocations every 5 minutes
and queue consumption on `kody-scheduled-dispatch`), schedule outbox health, a
due job running end-to-end (Temporal Schedule → `jobOccurrenceWorkflow` → a run
in the user's activity), and dashboards (`/account/jobs`) plus MCP `jobs_*`
listing `JOBS_DB` rows.
