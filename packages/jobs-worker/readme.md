# kody jobs worker

The jobs and scheduled lane extracted from the origin `kody` Worker per
[ADR 0016](../../docs/contributing/decisions/0016-mono-worker-extraction.md):
the dedicated `JOBS_DB` D1 database, Temporal Schedule synchronization, the
five-minute cron trigger, and the `kody-scheduled-dispatch` queue.

The Worker entry module is
[`packages/jobs-worker/src/index.ts`](./src/index.ts). Cron and queue dispatch
call back into origin `JobsHost` over the `HOST` service binding. There is no
public hostname; health is `GET /health` on the workers.dev URL the deploy
workflow records.

- `wrangler.jsonc` — the committed base config (script name `kody-jobs`).
  Deployable configs are written by
  [`tools/ci/jobs-worker-resources.ts`](../../tools/ci/jobs-worker-resources.ts).
- Build check: `npm run jobs:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
- Historical Durable Object transfer and current `JOBS_DB` ownership: see the
  [migration runbook](../../docs/contributing/architecture/jobs-worker-migration-runbook.md).

## Temporal schedules

Job mutations write a transactional schedule outbox beside `jobs`. The
`temporal_schedule_sync` lane runs every five minutes and applies those changes
to the configured Temporal service through the signed gateway. The checked-in
implementation uses a local Temporal development server; production service
selection and deployment are outside this change. The lane requires
`TEMPORAL_GATEWAY_URL` and `TEMPORAL_GATEWAY_SIGNING_KEYS`.

`job_schedule_bindings` and `job_schedule_outbox` are the permanent,
transactional handoff between authoritative `JOBS_DB.jobs` mutations and
Temporal Schedules. They are not a shadow scheduler or fallback lane.
