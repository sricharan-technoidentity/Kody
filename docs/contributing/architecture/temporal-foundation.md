# Temporal foundation

Temporal provides durable orchestration. It does not own Kody user data and it
does not execute user-authored package code.

## Local runtime

The Temporal worker and gateway run as persistent Node 26 processes against a
local Temporal development server. Their Debian-based Node 26 images provide a
reproducible local container path, but this work does not select, configure, or
migrate a production runtime or Temporal namespace.

For local development, start a self-contained Temporal server, then start the
worker and make its version current before sending workflow traffic:

```sh
docker run --rm --name kody-temporal-server -p 127.0.0.1:7233:7233 -p 127.0.0.1:8233:8233 --entrypoint temporal temporalio/admin-tools:1.31.2 server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0
npm run temporal:dev
npm run temporal:local:set-current
npm run temporal:gateway
```

The worker uses pinned Worker Versioning, so the local `set-current` step is
required before new workflows can reach a fresh development worker. The helper
refuses production mode and any non-loopback Temporal address. On Windows, use a
new terminal after selecting Node 26 with NVM so `node --version` reports the
Node 26 installation.

Package-specific process and environment notes live in the
[`temporal-worker`](../../../packages/temporal-worker/readme.md) and
[`temporal-gateway`](../../../packages/temporal-gateway/readme.md) READMEs.

Workflow code remains deterministic and version-safe, and the worker handles
`SIGTERM` with graceful Temporal shutdown. Those properties are verified locally
without claiming deployment or production compatibility evidence.

## Data-processing boundary

Allowed Temporal payloads are bounded identifiers, timestamps, trigger kinds,
idempotency keys, and immutable object references. Workflow IDs and search
attributes use opaque or hashed identifiers.

The following content stays in Cloudflare storage and crosses the boundary only
as an opaque reference. Both user and job correlation fields are deterministic,
user-scoped hashes; raw package-job IDs can contain user-authored job names and
therefore never cross the Temporal boundary:

- secrets and credentials;
- source code and prompts;
- package inputs and outputs;
- email bodies and attachments;
- account profile data, including usernames and email addresses.

`JOBS_DB` owns job definitions. Per-user `RunLog` objects own user-visible run
history. R2/KV/D1 and the relevant Durable Objects own application state.
Temporal Event History and Visibility contain operational workflow state only.

Account deletion first cancels open workflows by hashed user identifier, then
performs the existing Cloudflare deletion. Export reads Cloudflare authorities
only. Temporal namespace retention bounds residual operational history; raw
personal data is excluded from that history by contract.

## Signed gateways

Both gateway directions use the same canonical request scheme:

```text
METHOD\nPATHNAME\nTIMESTAMP_MS\nNONCE\nBODY_SHA256\nIDEMPOTENCY_KEY
```

Requests include a key ID, timestamp, nonce, body digest, signature, and an
idempotency key for every mutation. Verification accepts the configured current
and previous key IDs, applies a five-minute clock window, consumes each nonce
once, compares digests and signatures in constant time, enforces JSON body
limits, and validates an operation-specific schema. Keys rotate by deploying a
new current key while retaining the preceding key for one replay window.

The gateway has no arbitrary SQL, binding-name, or callback-URL operation.
Network ingress and coarse rate limiting are configured at Cloud Armor; the
application additionally rate-limits each signing key.

## Phase 0 behavior parity

| Existing behavior       | Temporal target                                          | Required proof                               |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Create job              | Persist in `JOBS_DB`, then reconcile a paused Schedule   | Lost-response and duplicate-create tests     |
| Update job              | Increment desired version and update Schedule            | Out-of-order update and drift repair tests   |
| Pause/resume            | Persist state before Schedule pause/unpause              | Reconciliation and concurrent update tests   |
| Delete job              | Tombstone/delete definition, then delete Schedule        | Idempotent delete and missing Schedule tests |
| Time zones/DST          | Temporal calendar spec with stored IANA zone             | Spring-forward and fall-back fixtures        |
| One-time schedule       | One Schedule occurrence with expiration                  | Exact timestamp and restart tests            |
| Recurring schedule      | Calendar/interval spec derived from current contract     | Seeded cron and interval fixtures            |
| Expiration              | Cloudflare definition fences execution; Schedule ends    | Boundary-time and stale-task tests           |
| Run now                 | Start occurrence workflow with a unique run reference    | Duplicate request and status tests           |
| Missed/catch-up         | Explicit catch-up window from existing behavior          | Downtime/backfill fixture tests              |
| Overlap                 | Existing D1 claim lease rejects concurrent occurrence    | Concurrent Activity and lease-expiry tests   |
| Retry/permanent failure | Temporal retries transient infrastructure only           | Exhaustion and non-retryable failure tests   |
| Cancellation            | Cancel workflow, abort Activity, finalize Cloudflare run | Pre-start/in-flight/post-terminal tests      |
| Account deletion        | Cancel by hashed owner, then existing deletion path      | Partial-failure and retry tests              |
| Account export          | Export Cloudflare authorities only                       | Export contains no Temporal dependency       |

## Capacity baseline

The production approval records a seven-day representative window and a separate
peak window. The capture contains aggregates only:

| Metric                        | Source                                     | Approval value             |
| ----------------------------- | ------------------------------------------ | -------------------------- |
| Active schedules              | `JOBS_DB.jobs` enabled, unexpired count    | Pending production capture |
| Executions/minute             | scheduled-dispatch structured events       | Pending production capture |
| Peak concurrent package runs  | RunLog/usage aggregate                     | Pending production capture |
| Average/maximum payload bytes | gateway size telemetry, references only    | Pending production capture |
| Job lag                       | scheduled-for to claim timestamp histogram | Pending production capture |
| Failure rate                  | terminal job-run aggregate by status       | Pending production capture |

These production capacity measurements remain required before deployment. They
are operational evidence, not runtime migration switches: the Phase 8 code has
one Temporal scheduling path and local development proves it against the local
Temporal harness.

## Phase 1 preview proof

An authenticated operator can invoke
`POST /__maintenance/temporal-foundation-smoke` with the existing maintenance
bearer secret. The origin signs a workflow-start request to the Temporal
gateway; the smoke workflow calls the signed Cloudflare package-resolution
endpoint and returns only opaque identifiers. A successful response proves the
Cloudflare → Temporal gateway → Temporal Activity → Cloudflare round trip. It
does not enable job traffic.

## Phase 2 schedule foundation

The dedicated `JOBS_DB` owns `job_schedule_bindings` and `job_schedule_outbox`.
Create, update, delete, and account-purge mutations write the authoritative job
change and matching outbox operation atomically. The reconciler uses
deterministic hashed Schedule IDs, retries lost responses with the same logical
idempotency key, ignores superseded versions, and compares next occurrence,
timezone, pause state, expiry, and desired version.

Phase 2 originally proved parity with paused sentinel Schedules. Phase 8 removed
that temporary workflow; the outbox now synchronizes authoritative Temporal job
Schedules. Component diagnostics report binding, pending, drift, error, and
claim counts without exposing user identifiers.

## Phase 3 scheduled-job cohorts

Phase 3 used cohorts to prove job execution. Phase 8 removes the cohort
controller and legacy alarm-backend selection; all active job Schedules now
start `jobOccurrenceWorkflow`.

`jobOccurrenceWorkflow` calls four signed Activities: claim, resolve the opaque
execution plan, execute in the Cloudflare package sandbox, and finalize. The
existing D1 `claim_token`, `claimed_scheduled_for`, lease, and
`last_completed_scheduled_for` fields remain the effective-once boundary.
Temporal Activity results contain only status, timestamps, error codes, and a
RunLog reference; package results and logs stay in Cloudflare.

## Phase 4 dynamic workflows

`workflows.create`, `workflowRunList`, and `workflowRunCancel` remain the public
contract. Each workflow projection records either the Cloudflare or Temporal
backend, and status refresh and cancellation dispatch through that recorded
backend. An explicit idempotency key is deduplicated across both backends for
the user, so changing the rollout gate cannot duplicate a logical operation.

New creates store source/input and caller context as separate content-addressed,
owner-scoped artifacts in `BUNDLE_ARTIFACTS_KV`. Temporal receives only opaque
artifact references and hashed correlation fields. `dynamicPackageWorkflow` uses
a durable Temporal timer for `runAt`, then a heartbeat-aware Activity calls the
signed Cloudflare gateway. Cloudflare verifies artifact ownership, executes user
code only in the existing package sandbox, keeps results/logs in `RunLog`, and
returns a stable result reference. A completed projection makes a lost-response
Activity retry return the original logical result instead of running the sandbox
again.

The adapter is fail-closed: missing gateway configuration or artifact storage
rejects creation. There is no Cloudflare Workflow fallback or mixed-backend
dispatch after Phase 8.

## Phase 5 package execution coordination

Temporal now coordinates both scheduled-job and dynamic-workflow package runs,
while execution remains inside the existing Cloudflare sandbox. Package
Activities heartbeat during the signed runtime request, combine Temporal
cancellation with the request timeout, and use bounded retry. Cloudflare maps
validation and deterministic user-package failures to non-retryable responses;
rate limits, transport failures, and platform 5xx responses remain retryable.

Every dynamic package Activity carries the workflow's stable, opaque invocation
idempotency key through to the package invocation ledger. A lost Activity
response can therefore retry without repeating billable effects. Scheduled jobs
continue to use their D1 claim/finalize fence. Both paths return only status and
opaque RunLog/result references to Temporal, so secrets, source, parameters,
logs, and package output do not enter workflow history.

The Node worker process runs orchestration and package-Activity workers on
separate task queues. Package execution uses `kody-package-activities`, whose
concurrency can be tuned independently with
`TEMPORAL_PACKAGE_ACTIVITY_MAX_CONCURRENT_EXECUTIONS`; the orchestration queue
remains lightweight. The same process and image may poll both queues.

## Phase 6 coordinator migration

Plan-relevant activity stores an exact-key Cloudflare owner mapping and sends a
signal-with-start to the deterministic per-user `stripePlanRefreshWorkflow`.
Repeated signals move the due time, so they coalesce like the existing one-shot
Durable Object alarm.

At the due time, a signed Activity resolves the opaque mapping in Cloudflare,
acquires the existing account write lease, and refreshes Stripe-derived billing
columns. `stripe_plan_refreshed_at` is the occurrence fence for a lost Activity
response. Raw stable user IDs and Stripe customer IDs never enter Temporal
history. Account deletion cancels the Workflow and removes the mapping. There is
no retained Durable Object coordinator or fallback lane after Phase 8.

## Local observability

The Temporal Worker exposes the SDK's Prometheus metrics on `/metrics`, using
`TEMPORAL_METRICS_BIND_ADDRESS`. Worker shutdown emits
`temporal_worker_lifecycle` events with the measured graceful-shutdown duration.
The Node control-plane gateway emits one bounded `temporal_gateway_request`
event per request with a normalized route, status, authentication outcome, and
duration; it never logs request bodies or workflow identifiers.

The Cloudflare Activity Gateway emits `temporal_activity_gateway_auth` events
for verified and rejected signatures. Temporal job claims emit
`temporal_job_occurrence_claim` with only the outcome and schedule-to-claim lag.
These stable events are the local metric inputs for gateway authentication,
schedule lag, claim conflicts, and rejected duplicates.

The hourly usage-aggregation lane also takes a bounded Temporal Visibility
sample for dynamic package workflows and reconciles it against the RunLog
projection. New executions carry only a hashed user, opaque RunLog identifier,
and opaque owner-artifact reference in Temporal memo fields; the Cloudflare
artifact resolves the RunLog owner without exposing identity to Temporal. Older
executions without those fields are reported as unattributed instead of guessed.
The lane emits content-free mismatch and summary events, while workflow
admission emits per-backend concurrency outcomes. This is local implementation
evidence only.

## Local development

This migration is implemented and verified locally only. It does not authorize
or perform a production Temporal migration, production deployment, or production
Worker Deployment routing change.

Start a disposable local server with the official Temporal CLI image:

```sh
docker run --rm --name kody-temporal-server --publish 127.0.0.1:7233:7233 --publish 127.0.0.1:8233:8233 --entrypoint temporal temporalio/admin-tools:1.31.2 server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0
```

Then use separate terminals for the long-running worker and gateway:

```sh
npm run temporal:dev
npm run temporal:local:set-current
npm run temporal:gateway
```

Run `temporal:local:set-current` after the worker has registered its
`development` build. Temporal Worker Versioning is pinned, so a new local server
will leave work backlogged until that version is current. The helper accepts
loopback Temporal addresses only and refuses to run when `NODE_ENV=production`.

The worker reads `packages/temporal-worker/.env` and the gateway reads
`packages/temporal-gateway/.env`. For an end-to-end Activity call, point
`CLOUDFLARE_ACTIVITY_GATEWAY_URL` at the local origin and use the same
`CLOUDFLARE_ACTIVITY_SIGNING_KEYS` value in the worker and origin environments.
The gateway needs `TEMPORAL_GATEWAY_SIGNING_KEYS`; callers must use the matching
value. Keep the two signing key sets separate.

`temporal:dev` starts both the orchestration and package-Activity pollers. The
worker pre-bundles deterministic workflow code for production with
`npm run temporal:build`; Activities and gateway code are ordinary Node modules
and are excluded from the workflow bundle.
