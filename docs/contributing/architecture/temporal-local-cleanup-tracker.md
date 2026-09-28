# Temporal local migration result

This file records the completed local cleanup of migration-only surfaces. It is
not a deferred-work tracker: the permanent outbox and binding tables are active
architecture, and production rollout is outside the scope of this local change.

## Local Phase 8 result

The Cloudflare workflow backend, JobManager execution path, StripePlanRefresh
Durable Object path, bindings, exports, feature flags, dual-lane adapters,
watchdog, compatibility tests, and local configuration are removed. Dynamic
workflows, scheduled job occurrences, and Stripe plan refresh coordination now
route only through Temporal.

`job_schedule_bindings` and `job_schedule_outbox` remain intentionally. They are
the permanent transactional handoff between authoritative job mutations in
`JOBS_DB` and the configured Temporal service, not coexistence or fallback
tables.

Local proof uses the same gateway and worker contracts intended for a managed or
self-hosted Temporal deployment. The local development server is a test harness,
not a production service choice.

## Production boundary

Production rollout, production namespace changes, remote resource deletion,
Cloudflare `deleted_classes` migrations, and production evidence are explicitly
out of scope. The committed historical migration records stay intact, and this
local implementation does not create a deferred production task, issue, or
runbook.

## How to verify

- `npm run validate` passes.
- Multi-worker local development proves origin, platform, and runtime
  forwarding.
- Repository search finds no active references to retired classes, bindings,
  flags, adapters, or shadow execution.
- Local D1 migration replay and Temporal history replay remain green.
- Temporal history replay and local failure-path tests remain green.

## Introduced by

The local Phase 2 through Phase 6 implementation documented in
[Temporal migration plan](./temporal-migration-plan.md).
