# Kody → Temporal + AgentCore: POC Execution Plan

Status: **Draft v1** · Created 2026-09-30 · Repo: `kody` @ `3f94e20` Design
source: project doc _Kody on Temporal + AgentCore — Target Architecture_ (the
"target doc").

This plan is written for a coding agent to execute phase by phase. It is a
**POC**: mock credentials, in-process fakes, no deploys, no data migration.
Tests change first in every phase, then the code follows.

---

## 0. Agent protocol (read every session)

1. Open this file. Find the first phase in the **Status board** that is not
   `[x]`.
2. Run that phase's **Entry check**. If it fails, fix the previous phase first.
3. Continue from the first unchecked box in that phase. Tick boxes as you finish
   them (`[ ]` → `[x]`). Use `[~]` for "started, not done" and `[-]` for
   "skipped on purpose" (write why in the log).
4. At the end of a phase, run the **Gate** commands, paste the numbers into the
   **Phase log** row, set the phase to `[x]` on the Status board, and write a
   3–5 line handoff note under **Handoff notes**.
5. If you change the plan (new step, dropped step, different library), record it
   in **Decisions and deviations**. Do not silently rewrite earlier phases.

### Hard rules

- **No git writes.** No `git commit`, `git push`, `git stash`, branch changes or
  tags. No husky, lint-staged or pre-commit hooks. Use `HUSKY=0` and
  `--ignore-scripts` during install. `git status` / `git diff` are fine for
  reviewing work.
- Use each phase's Gate plus checks of its architectural behavior to track
  incremental migration progress. The current `AGENTS.md` instructions require
  `npm run validate` as the authoritative local gate; phase checks do not
  replace it. Run relevant typecheck, lint, format, and regression checks too.
  Never run `npm run deploy*`, standalone `wrangler` commands, `cdk deploy`, or
  anything that talks to real AWS, Cloudflare or Temporal Cloud.
- **Mock credentials only** (section 3). If code needs a secret that is not in
  section 3, add a fake value there and use it.
- **Network** is allowed for npm dependency install, the one-time Temporal
  test-server download. Tests use local services and mock credentials.
- **Test style stays Kody's**: flat top-level `test(...)`, no
  `beforeEach`/`afterEach`, fewer longer tests, explicit factories from
  `test-support/` (see `docs/contributing/testing-principles.md`).
- **Tests first.** In every phase: rewrite or add the tests (red), then change
  code (green). Never delete a behaviour test just because it is red; delete
  only tests of Cloudflare-only mechanics (recipe in section 5).
- **POC shortcuts** that have a known ceiling get a
  `// ponytail: <ceiling>, <upgrade path>` comment so they can be harvested
  later.

---

## 1. Status board

| #   | Phase                                                                        | Status | Tests owned (CF-coupled / total) |
| --- | ---------------------------------------------------------------------------- | ------ | -------------------------------- |
| P0  | Baseline, guardrails, mock credentials, spikes                               | [x]    | —                                |
| P1  | Prune Cloudflare-only surface                                                | [x]    | tooling + sibling packages       |
| P2  | Target test harness + acceptance suite (red)                                 | [x]    | 10 new files                     |
| P3  | Relational store: D1 → Aurora PostgreSQL (PGlite in tests)                   | [x]    | ~200                             |
| P4  | Key-value, objects, keys: DynamoDB, S3, KMS, AgentCore Identity              | [x]    | ~55                              |
| P5  | Orchestration: Temporal workflows replace DO alarms, Workflows, Queues, Cron | [x]    | ~40                              |
| P6  | Sandbox: AgentCore Runner, broker, egress proxy, storage cells               | [ ]    | ~220                             |
| P7  | Front door, MCP server, app edge on Node; e2e rewired                        | [ ]    | ~20 + e2e                        |
| P8  | Final sweep: zero Cloudflare references, full green                          | [ ]    | remainder                        |
| P9  | (Optional) CDK infra synth test                                              | [ ]    | 1 new file                       |

Baseline numbers at plan time (`3f94e20`): **1,215 test files**: 1,096
`*.node.test.ts`, 102 `*.workers.test.ts`, 5 `*.mcp-e2e.test.ts` and 13
Playwright specs. Of these, **581** reference Cloudflare bindings or runtime
APIs. The P1 deletions (sibling packages and CF tooling) take about 60 of the
581 off the list.

---

## 2. What maps to what (from the target doc)

| Today (Cloudflare)                                                                                           | Target (AWS / Temporal)                                                                | POC test double                                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1 `APP_DB`, `AUDIT_DB`                                                                                      | Aurora PostgreSQL (reader + writer roles, RLS on `user_id`)                            | **PGlite** + `pgvector`, run as a non-superuser role so RLS applies |
| Vectorize                                                                                                    | pgvector + Postgres full-text in Aurora                                                | PGlite `vector` extension                                           |
| `OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`                                                                            | DynamoDB `oauth` table; S3                                                             | In-memory KV-shaped fake; in-memory object store                    |
| R2 buckets                                                                                                   | S3 (same object keys)                                                                  | In-memory object store                                              |
| `UserMeter` DO                                                                                               | DynamoDB `meters` (conditional updates)                                                | In-memory meter store with conditional semantics                    |
| `RunLog` DO                                                                                                  | DynamoDB `runs` + `idempotency` (90-day TTL) + S3 logs                                 | In-memory tables                                                    |
| `StorageRunner` DO                                                                                           | Storage cell: SQLite file per bucket, DynamoDB lease with fencing token                | `node:sqlite` + in-memory lease table                               |
| `KodyFetchGateway` DO                                                                                        | Egress proxy service                                                                   | Plain module, `msw` for outbound calls                              |
| Worker Loader isolates (`executor.ts`)                                                                       | Kody Runner on AgentCore Runtime (`workerd` inside)                                    | Fake Runner client; optional `node:vm` executor                     |
| Service-binding RPC from `kody:runtime`                                                                      | Capability broker over HTTPS with signed run token                                     | In-process broker handler                                           |
| `RepoSession` DO + `@cloudflare/shell`                                                                       | `RepoSession` entity workflow + AgentCore Code Interpreter                             | Fake code interpreter (file map + scripted command results)         |
| `Mailbox` DO, Email Routing, `EMAIL`                                                                         | Aurora + S3 + SES                                                                      | PGlite + object store + in-memory SES outbox                        |
| `McpClientHub` DO                                                                                            | Aurora registrations + AgentCore Identity token vault + `McpServerConnection` workflow | PGlite + in-memory vault                                            |
| `SECRET_STORE_KEY`                                                                                           | KMS envelope encryption, context `{userId}`                                            | WebCrypto AES-GCM fake that enforces encryption context             |
| DO alarms, Cloudflare Workflows, Queues, Cron, `jobs-worker`                                                 | Temporal workflows, Schedules, task queues `app`/`platform`/`runtime`/`ops`            | `@temporalio/testing` `TestWorkflowEnvironment` (time skipping)     |
| `MCP` DO (`McpAgent`)                                                                                        | MCP server on AgentCore Runtime (MCP protocol)                                         | Node handler in-process                                             |
| Origin `fetch` handler on Workers                                                                            | Front door on Node (ECS Fargate)                                                       | `node:http` server wrapping the same fetch handler                  |
| `highlight-worker`                                                                                           | Shiki as a library in the front door                                                   | Direct function call                                                |
| `status`, `nx-cache`, `backup-control-plane`, `platform-worker`, `runtime-worker`, `mock-servers/cloudflare` | CloudWatch Synthetics, S3 cache, AWS Backup, ECS services                              | **Deleted** (out of POC scope)                                      |

### POC defaults for the target doc's open decisions

| Open decision                         | POC default                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Package-app requests outside Temporal | Yes: app requests, realtime and retrievers call the Runner directly (as proposed)                                                        |
| Billing units                         | Keep existing meter names; add a `sandbox_compute_ms` counter the Runner fake reports                                                    |
| Integration token fallback            | Vault fake accepts imports; no KMS fallback path in the POC                                                                              |
| Cutover downtime / data copy          | Out of scope. Only the frozen-key conformance test is in scope                                                                           |
| Region                                | `us-east-1` in all mock ARNs                                                                                                             |
| Temporal namespaces + Nexus           | Test env uses one namespace; namespace names and task queues follow the design; Nexus calls become child workflows (`// ponytail:` note) |

### Where new code lives (one package, new folders)

Keep everything inside `packages/worker/src/` for the POC; split into the target
doc's separate packages later.

```
packages/worker/src/
  aws/            adapters: pg facade, dynamo, s3, kms, ses, agentcore (runner, identity, code interpreter)
  temporal/       workflows/, activities/, worker.ts, client.ts, codec.ts, ids.ts
  runner/         runner client, run-token mint/verify, supervisor (optional)
  broker/         capability broker handler
  egress/         egress proxy (from mcp/fetch-gateway.ts)
  storage-cell/   storage cell + lease (from storage-runner.ts)
  front-door/     node:http server, env builder, read/write split
  test-support/aws/   all fakes + createTargetTestEnv()
packages/worker/migrations-pg/   Postgres schema (baseline + RLS)
```

---

## 3. Mock credentials and config

Put these in `packages/worker/.env.test` (create it) and load it from
`vitest-shared.ts` alongside the existing `.env` load. Nothing here is real; the
AWS key pair is AWS's own documentation example.

```dotenv
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_ACCOUNT_ID=000000000000
DATABASE_WRITER_URL=postgres://kody_writer:mock@localhost:5432/kody
DATABASE_READER_URL=postgres://kody_reader:mock@localhost:5432/kody
DYNAMO_TABLE_METERS=kody-test-meters
DYNAMO_TABLE_OAUTH=kody-test-oauth
DYNAMO_TABLE_RUNS=kody-test-runs
DYNAMO_TABLE_IDEMPOTENCY=kody-test-idempotency
DYNAMO_TABLE_LEASES=kody-test-leases
S3_BUCKET_BUNDLES=kody-test-bundles
S3_BUCKET_BLOBS=kody-test-blobs
KMS_KEY_ID=alias/kody-test
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE_CORE=kody-core
TEMPORAL_NAMESPACE_EXEC=kody-exec
TEMPORAL_NAMESPACE_OPS=kody-ops
AGENTCORE_RUNNER_ARN=arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/kody_runner_test
AGENTCORE_MCP_ARN=arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/kody_mcp_test
AGENTCORE_CODE_INTERPRETER_ID=kody_checks_test
AGENTCORE_IDENTITY_WORKLOAD=kody-egress-test
RUN_TOKEN_SIGNING_KEY=mock-run-token-signing-key-000000000000
BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0
SES_FROM_DOMAIN=inbox.kody.test
```

Keep existing test values for `COOKIE_SECRET` and the rest from
`packages/worker/.env.example`.

---

## 4. Verified commands

Fill this block in P0 with the exact commands that work in this checkout, then
use only these.

```bash
# install (no hooks; npm needs registry access in this checkout)
HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund && HUSKY=0 npm rebuild --no-audit --no-fund
# one test file / folder
CI=1 npx vitest run --project node-unit <path>
# whole node suite
CI=1 npx vitest run --project node-unit
# typecheck (worker)
npx tsc -b packages/worker/tsconfig-client.json packages/worker/tsconfig-worker-typecheck.json --noEmit
# authoritative local gate (current AGENTS.md instructions)
CI=1 WRANGLER_SEND_METRICS=false XDG_CONFIG_HOME=/tmp/kody-p0-config npm run validate
# mcp e2e (after P7)
CI=1 npx vitest run --project mcp-e2e
# playwright smoke (after P7)
<fill in P7>
# Cloudflare-reference gate (P8 target: only allowlisted files)
grep -rlE "cloudflare:|D1Database|DurableObject|idFromName|KVNamespace|R2Bucket|wrangler|WorkflowEntrypoint" packages e2e tools --include=*.ts --include=*.tsx | grep -v node_modules
```

---

## 5. Test rewrite recipe (use for every CF-coupled test)

Decide per file, top to bottom; the first rule that matches wins.

| #   | If the test…                                                                                                                                                                                  | Then                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Asserts Cloudflare-only mechanics: DO alarms or RPC serialisation, wrangler config, Worker Loader or startup CPU budget, D1 bind-count limits, Miniflare, queue batch shapes, `ctx.waitUntil` | **Delete.** Add the path and a one-line reason to the **Deleted tests log**                                                 |
| 2   | Uses `createD1FromSqlite(new DatabaseSync(...))` with hand-written schema (119 files at plan time)                                                                                            | Replace with `await createTestDb()` (baseline schema applied). Drop the hand schema. Fix SQL-string assertions for Postgres |
| 3   | Imports `env` from `cloudflare:test` / `cloudflare:workers` (42 use `cloudflare:test`)                                                                                                        | Use `const { env } = await createTargetTestEnv()`; rename file `*.workers.test.ts` → `*.node.test.ts`                       |
| 4   | Calls a DO through `idFromName` / stub                                                                                                                                                        | Call the replacement store/service/workflow directly (see section 2)                                                        |
| 5   | Checks KV/R2 keys                                                                                                                                                                             | Keep the exact key strings; assert them on the DynamoDB/S3 fake (frozen-key rule)                                           |
| 6   | Spies on functions (`vi.spyOn(recordUsage)`)                                                                                                                                                  | Keep as is                                                                                                                  |
| 7   | Pure logic, no bindings                                                                                                                                                                       | Leave it alone; it should pass unchanged                                                                                    |

Rules: keep assertions on behaviour; change setup, not intent. If a test needs a
new fake capability, add it to `test-support/aws/` rather than inlining a mock.

---

## P0 — Baseline, guardrails, mock credentials, spikes

**Goal:** a working, hook-free checkout with a recorded baseline and the risky
test libraries proven. **Entry check:** repo cloned; `node --version` works.

- [x] Install Node ≥ 26 (the repo's `engines`; the sandbox had v22 at plan
      time). Record the version in the Phase log.
- [-] `git config core.hooksPath /dev/null` — this checkout is nested inside a
  parent Git repository whose `.git` is outside the writable project root. Used
  `HUSKY=0` and `--ignore-scripts`; the 14 existing hook files were unchanged.
- [x] Install without lifecycle hooks:
      `HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund && HUSKY=0 npm rebuild --no-audit --no-fund`.
      Confirm `.git/hooks` has no new files.
- [x] Copy `packages/worker/.env.example` → `packages/worker/.env`; create
      `packages/worker/.env.test` from section 3.
- [x] Find the working typecheck command (start from `package.json` `typecheck`,
      trimmed to the worker) and fill section 4.
- [x] Baseline: `CI=1 npx vitest run --project node-unit` → 3,624 passed, 2
      failed, 0 skipped (1,088 files passed, 2 failed). List pre-existing
      failures in **Known failures** so later gates don't blame them on the
      migration.
- [-] (Reference only) Try `CI=1 npx vitest run --project workers-unit`; sandbox
  denied loopback/log writes; the permitted retry stalled after `workerd` failed
  DNS lookup for `artifacts-mock.test`, so it was stopped without a suite count.
- [x] Spike A — **PGlite**: add `@electric-sql/pglite` and
      `@electric-sql/pglite-pgvector` (dev). In a scratch test, open
      `new PGlite({ extensions: { vector } })`, `CREATE EXTENSION vector`,
      create a non-superuser role, enable `FORCE ROW LEVEL SECURITY` on a table,
      `SET ROLE`, and prove a cross-user `SELECT` returns 0 rows. Result: Alice
      and Bob each saw only their own row. Create plus vector: 2,505 ms; 100
      vector tables: 230 ms; total: 2,751 ms.
- [x] Spike B — **Temporal testing**: add
      `@temporalio/{client,worker,workflow,activity,testing}`. A time-skipping
      workflow with a one-hour timer completed locally and returned
      `time skipped`. The one-time ephemeral server download needed network
      permission; no cloud service was contacted.
- [x] Spike C — **AgentCore SDK**: add `@aws-sdk/client-bedrock-agentcore`;
      `InvokeAgentRuntimeCommand` is exported. `runtimeSessionId` has a 33–256
      character service constraint for P6.
- [x] Delete the scratch spike tests.

**Gate:** baseline numbers and verified commands filled in; three spikes
recorded.

---

## P1 — Prune Cloudflare-only surface

**Goal:** remove everything the target architecture has no use for, without
breaking what remains. **Entry check:** P0 `[x]`; node-unit baseline recorded.

Tests first:

- [x] Build `docs/migration/workers-tests-inventory.md`: one row per
      `*.workers.test.ts` (102 files) with the recipe rule (section 5) and
      owning phase. Rule-1 files are deleted now; the rest are rewritten in
      their phase.
- [x] Delete rule-1 workers tests and log them.
- [x] Remove `./vitest.workers.config.ts` from the projects in
      `vitest.config.ts`, then delete the file. Delete the
      `tools/vitest-global-setup-*` files that only serve it (keep
      `worker-bundler-modules` and `guide-catalog-modules` if node-unit still
      uses them).

Delete packages. First run `grep -r "<package-name>" packages/worker`, and move
any imported pure helper into `packages/worker/src` before deleting:

- [x] `packages/platform-worker`, `packages/runtime-worker`
- [x] `packages/jobs-worker` (becomes Temporal Schedules in P5; note the
      `jobs-worker/migrations` tables for the P3 schema)
- [x] `packages/highlight-worker`. First move the Shiki highlight function into
      `packages/worker/src/highlight/` with its 2 tests
- [x] `packages/status`, `packages/nx-cache`, `packages/backup-control-plane`
- [x] `packages/mock-servers/cloudflare`,
      `packages/worker/src/test-support/cloudflare-mock-server*.ts`

Delete Cloudflare tooling in `tools/` (and their tests):

- [x] `wrangler-*`, `deploy.ts`, `check-deploy-guardrails*`,
      `check-worker-startup-*`, `worker-startup-*.json|md`,
      `worker-additional-module-allowlist*`, `origin-worker-config*`,
      `local-d1-persist*`, `export-d1-remote-to-sqlite.sh`,
      `vite-worker-whole-graph-reload*`,
      `wrangler-filter-kody-generated-watch*`, `tools/ci/*-resources.ts`,
      `tools/disaster-recovery/*d1*`
- [x] Anything else in `tools/` whose only purpose is Cloudflare deploy/DR
      (decide per file; log each in
      [`docs/migration/p1-pruned-tooling.md`](../docs/migration/p1-pruned-tooling.md))

`package.json`:

- [x] Remove `prepare` (husky), `lint-staged`, and scripts for deleted things
      (`*:build`, `*:deploy`, `backup:*`, `status:*`, `nx-cache:*`,
      `worker-startup-*`, `deploy-guardrails:check`, `test:workers`).
- [x] Keep `npm run validate` as the authoritative gate; update it to remove
      checks for deleted Cloudflare packages and include POC typecheck and
      `test:node`.
- [x] Do **not** remove `wrangler` / `@cloudflare/*` deps yet; runtime code
      still imports them until P7.

**Gate:** node-unit passes equal baseline passes minus deleted tests, with no
new failures. Typecheck is clean, or fails only on items already in Known
failures. Record counts.

---

## P2 — Target test harness + acceptance suite (red)

**Goal:** all fakes exist, and the target architecture is written down as
failing tests. This is the "change the tests first" phase for the new
architecture. **Entry check:** P1 `[x]`; PGlite and Temporal spikes passed (or
fallback recorded).

Fakes in `packages/worker/src/test-support/aws/` (each file one factory, no
globals):

- [x] `test-db.ts` — `createTestDb({ userId? })`: PGlite + vector, applies
      `migrations-pg/*.sql`, returns `{ db, reader, pg }`. `db` is a **D1-shaped
      facade** (`prepare().bind().all/first/run/raw`, `batch()` in one
      transaction, `?` → `$n`) so existing call sites keep working. `reader`
      throws on any write statement. Tip: build a template once per worker with
      `dumpDataDir()` and clone it per test for speed.
- [x] `fake-kv-table.ts` — DynamoDB-shaped item store: get/put/delete,
      conditional update, query by partition + sort prefix, TTL. When
      constructed with a session `userId`, it rejects items whose partition key
      does not start with it (mirrors `dynamodb:LeadingKeys`).
- [x] `fake-object-store.ts` — S3-shaped get/put/list/delete by key; optional
      prefix guard per user.
- [x] `fake-kms.ts` — envelope encrypt/decrypt with AES-GCM; decrypt fails if
      encryption context differs.
- [x] `fake-token-vault.ts` — AgentCore Identity: store/fetch OAuth tokens per
      `(userId, provider)`; only allowed workload names may fetch.
- [x] `fake-runner.ts` — AgentCore Runtime client: records
      `{ runtimeSessionId, payload }`, scripted responses, optional `node:vm`
      executor for simple code (`// ponytail: not a security boundary`).
- [x] `fake-code-interpreter.ts` — file map + scripted results for `bundle`,
      `typecheck`, `lint`.
- [x] `fake-ses.ts` — outbox array + inbound event helper.
- [x] `temporal-env.ts` — wraps `TestWorkflowEnvironment`;
      `startWorker({ taskQueue, activities })` using a cached
      `bundleWorkflowCode` result.
- [x] `target-test-env.ts` — `createTargetTestEnv()` wires all of the above into
      one `env` object matching the new `AwsEnv` type, with section-3 values.
- [x] One node test per fake that checks its guard (cross-user key rejected,
      wrong KMS context fails, reader refuses writes).

Stubs so the red suite typechecks: create each new module in section 2's layout.
Each one exports its functions/workflows, and each export throws
`new Error('not implemented: <name>')`.

Acceptance tests (one file each, long journey tests, all red at the end of P2):

- [x] `temporal/execute-run.node.test.ts`. `execute` → Update-with-Start
      `ExecuteRun` (id `{userId}:execute:{requestId}`) → meter consumed (fails
      closed when spent) → run token minted → Runner invoked with a per-user
      `runtimeSessionId` → result capped at 100 KB → run record written. The
      same `requestId` sent twice runs once.
- [x] `temporal/webhook-delivery.node.test.ts`. Valid HMAC → `WebhookDelivery`
      `{endpointId}:{deliveryId}` → `ack` returns 202 after Start, `sync`
      returns the result. A duplicate delivery attaches to the same workflow. A
      bad HMAC or a replay starts nothing. The rate limit returns 429.
- [x] `temporal/job-run.node.test.ts`. Schedule `job:{userId}:{jobId}` fires
      `JobRun` → `job_runs_per_day` consumed → a failure emits
      `run.error.recorded` into `EventFanout` → the subscriber's
      `PackageInvocation` runs.
- [x] `temporal/publish-package.node.test.ts`. Checks run in the code
      interpreter → a locked package waits on the `HumanApproval` signal (an
      agent cannot send it) → bundle stored in S3 by commit → reindex →
      `published_commit` advances last.
- [x] `broker/capability-broker.node.test.ts`. The run token is verified on
      every call. Expired or tampered tokens are refused. The storage bucket
      comes from the token's provenance, not from the request.
- [x] `egress/egress-proxy.node.test.ts`. Placeholders are resolved only here.
      Retriever tokens are refused. Hosts are checked against the allowlist and
      `required_hosts`. Kody hostnames, private ranges and the metadata IP are
      blocked. `outbound_fetches_per_day` fails closed.
- [x] `storage-cell/storage-cell.node.test.ts`. The `sql()` API is unchanged.
      The lease uses a fencing token, so a stale owner's write is rejected.
      `storage_bytes` is reserved before each write. The 1,000-row cap holds.
- [x] `front-door/read-write-split.node.test.ts`. A GET page renders from
      `reader` only. A form POST becomes a Temporal Update and never touches the
      writer directly. The read-after-write flag routes the next read to the
      writer.
- [x] `security/isolation.node.test.ts`. User A cannot read user B's data
      through Postgres RLS, the KV fake, the object store or a KMS context. A
      suspended or unverified user is refused at the front door, broker and
      egress proxy.
- [x] `aws/frozen-keys.node.test.ts`. A table maps every frozen key format in
      `docs/contributing/architecture/data-storage.md` (KV keys, R2 keys, DO
      ids, Vectorize metadata) to its new home. The test asserts that the new
      adapters write byte-identical strings.

**Gate:** every new file compiles. The 10 acceptance files fail only with
`not implemented`. The fake self-tests are green, and old node-unit is still at
P1 numbers.

---

## P3 — Relational store: D1 → Aurora PostgreSQL

**Goal:** all SQL runs on Postgres (PGlite in tests), with RLS on `user_id` and
reader/writer roles. **Entry check:** P2 `[x]`.

Schema (tests depend on it, so it comes first):

- [x] Apply all 71 application SQLite migrations (the current checkout count) to
      a scratch SQLite DB, dump the final schema, and translate it to
      `packages/worker/migrations-pg/0001_baseline.sql`. Use a one-off script in
      `tools/pg/` and delete it afterwards. Include the `JOBS_DB` tables that
      survive (job config rows). Squashing is a POC choice: log it.
- [x] Add `0002_rls.sql`: extend the `kody_writer` and `kody_reader` roles
      created by `0000_p2_harness.sql` with grants for the application schema.
      `ENABLE` and `FORCE ROW LEVEL SECURITY` on every table with `user_id`,
      with the policy `user_id = current_setting('app.user_id', true)`. The four
      documented cross-user exceptions get a separate admin role.
- [x] Add `0003_vectors.sql`: pgvector tables replacing Vectorize namespaces
      (`user_id` column; built-ins under `__kody_builtin__`), plus a full-text
      index.

Tests first (rules 2–3 in section 5), then code, per directory. For folders over
30 files, work in batches of ≤15 and log each batch.

| Folder                                                                        | CF-coupled / total | Done |
| ----------------------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/app`                                                              | 114 / 176          | [x]  |
| `worker/src/community`                                                        | 19 / 31            | [x]  |
| `worker/src/package-registry`                                                 | 14 / 21            | [x]  |
| `worker/src/identity`                                                         | 10 / 18            | [x]  |
| `worker/src/admin`                                                            | 7 / 8              | [x]  |
| `worker/src/account`                                                          | 6 / 7              | [x]  |
| `worker/src/vectorize` → rename `search-index`                                | 6 / 7              | [x]  |
| `worker/src/platform-feedback`                                                | 5 / 5              | [x]  |
| `worker/src/feature-flags`                                                    | 3 / 3              | [x]  |
| `worker/src/status-incidents`, `site-banners`, `security`, `discord`, `oidc`  | 7 / 12             | [x]  |
| `worker/universal`, `worker/client` (D1-touching only)                        | 6 / 196            | [x]  |
| `worker/src/(root)` D1 files: `db.ts`, `d1-*`, `database-errors`, `audit-log` | subset of 30 / 55  | [x]  |

Code:

- [x] `aws/pg-database.ts` — the same D1-shaped facade, over a `pg` Pool in
      production and PGlite in tests. Keep the binding name `env.APP_DB` for the
      POC (`// ponytail: D1-shaped facade, replace with typed queries later`).
      Add `env.APP_DB_READER`.
- [x] Every request/activity sets `app.user_id` in its transaction. _The facade
      sets it locally in every transaction and refuses `set_config` in prepared
      SQL; signed-out flows reach an account only through owner definers. P7
      builds the per-request writers (`APP_DB_FOR_USER`, pre-auth writer,
      roles)._
- [x] Translate SQLite-isms in source (file counts at plan time). _P3-owned code
      is translated. The rest sits in files later phases replace or own: Durable
      Object storage SQL (`run-log-do`, `user-meter-do`,
      `repo-session-index-do`, `storage-runner`, storage capability), email
      stores (P6), `entitlements`/`billing`/`integrations`/`mcp/secrets` (P4–P5)
      and SQLite test schemas for those suites:_
  - `INSERT OR IGNORE/REPLACE` (17) → `ON CONFLICT`
  - `json_extract`/`json_each`/… (11) → `->>` / `jsonb_*`
  - `datetime`/`strftime`/`julianday` (12) → `now()` / `to_char`
  - `AUTOINCREMENT` (8) → identity columns
  - `GLOB` (2) → `LIKE` or regex
  - `PRAGMA` (8) → remove
  - `last_row_id` (3) → `RETURNING id`
  - `.batch()` (22) → facade transaction
  - Watch `d1-like-pattern.ts`: SQLite `LIKE` is case-insensitive and Postgres
    `LIKE` is not, so use `ILIKE`.
- [x] Vector search: replace Vectorize calls with pgvector queries. Embeddings
      go through a Bedrock client port; the fake returns deterministic vectors
      from a text hash. _Index access goes through `getCapabilityVectorIndex`
      (prefers `SEARCH_INDEX`); remaining `CAPABILITY_VECTOR_INDEX` mentions are
      `Env` types and error text until P7's `AwsEnv`._
- [-] Delete `test-support/create-d1-from-sqlite.ts`, `d1-prepared-batch.ts`,
  `apply-all-migrations.ts`, `d1-retry.ts` (and tests) once no importer remains.
  _`d1-prepared-batch.ts` is deleted. The other three keep importers only in
  folders owned by P4–P6, so the condition is not met in P3; deletion moves to
  the P8 sweep (see Decisions)._

**Gate:** all folders in the table ticked; node-unit has no new failures; the
Postgres part of acceptance `security/isolation` is green.

---

## P4 — Key-value, objects, keys: DynamoDB, S3, KMS, AgentCore Identity

**Goal:** no KV, R2 or per-user-state Durable Object remains. **Entry check:**
P3 `[x]`.

| Folder / files                                                 | CF-coupled / total | Done |
| -------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/entitlements` (UserMeter)                          | 7 / 10             | [x]  |
| `worker/src/usage`                                             | 15 / 26            | [x]  |
| `worker/src/run-records` (RunLog)                              | 6 / 7              | [x]  |
| `worker/src/storage-buckets`                                   | 4 / 4              | [x]  |
| `worker/src/integrations`                                      | 8 / 13             | [x]  |
| root `oauth-*` files (grants, refresh family, purge, handlers) | ~12                | [x]  |
| secrets code paths (grep `SECRET_STORE_KEY`)                   | —                  | [x]  |

_Row notes: `entitlements` keeps its two logic-level D1 emulators
(`entitlements`, `usage-snapshot`) and `referral-program` on SQLite (billing
reward flow, P5); `usage` keeps the Durable Object billing telemetry modules
until the DOs they measure are gone; root `oauth-*`: `oauth-handlers` and
`oauth-refresh-family` Workers suites are P7, `oauth-purge` is a P5 ops lane;
`run-records` moves run history, logs, keyed claims, triage and the job /
activation counters to `RUN_RECORDS`, while the invocation ledger and workflow
projections stay on the RunLog DO for P5 (remnant suites
`invocation-ledger`/`dedicated-state.workers`, sandbox case in
`sandbox-logs.workers.test.ts` for P6). See the P4 batch log and Decisions._

Code:

- [x] `aws/dynamo-meters.ts` — `meters` table, key `userId` / `counter#day`,
      conditional atomic updates; replaces `entitlements/user-meter-do.ts` and
      `user-meter-client.ts`. Replace `test-support/user-meter.ts` with the
      fake. _Full `UserMeterRpc` port (`createDynamoUserMeters`, binding
      `USER_METERS`); DO deleted._
- [x] `aws/dynamo-kv.ts` — a `KVNamespace`-shaped adapter (get/put/delete/list
      with cursor) over the `oauth` table. `@cloudflare/workers-oauth-provider`
      storage then keeps working with identical key strings. Replace
      `test-support/memory-kv.ts`. _`memory-kv.ts` is now this adapter over the
      DynamoDB fake; exact-last-page `list` bug fixed._
- [x] `aws/s3-objects.ts` — R2-shaped get/put/list/delete over S3 with the same
      keys (bundles, MIME, assets, logs).
- [x] `aws/dynamo-runs.ts` — `runs` (90-day TTL) and `idempotency`
      (`userId#surface#key`) tables; replaces `run-records/run-log-do.ts`.
      _`createDynamoRunRecords` (binding `RUN_RECORDS`, `forUser(userId)`) is a
      faithful port of RunLog's run history: `run#<id>` items with a
      `runs-by-started` GSI, logs in S3 (`run-logs/<userId>/<runId>.json`),
      `claim#<surface>#<key>` idempotency owners, triage, stale-running heal,
      30-day TTL + 2,000-run cap, and the job/activation counters committed in
      the finish transaction. `runLogRpc` is a composite: run methods go to
      `RUN_RECORDS`, ledger and projections to the DO (P5).
      `createDynamoIdempotency` keeps the 90-day `idempotency` table for P5
      workflow starts._
- [x] `aws/kms-envelope.ts` — encrypt/decrypt with context `{ userId }`,
      replacing AAD `user:<userId>`. _Every `mcp/secrets/crypto.ts` purpose now
      goes through `env.SECRET_KMS`._
- [x] `aws/agentcore-identity.ts` — token vault client; only egress proxy and
      MCP-client activities may fetch.
- [x] One adapter test per production adapter using an injected `send` (see
      Decisions) to check command shapes (keys, condition expressions,
      encryption context).
- [x] Delete the replaced DO classes, `cloudflare-kv-platform-error.ts`, and the
      `oauth-purge` DO (it becomes a P5 ops lane). Delete `kv-cachified.ts` too,
      or re-point it at the new KV. _P4 part done: `UserMeter` and
      `cloudflare-kv-platform-error.ts` deleted; `kv-cachified.ts` kept (it
      takes any `KVNamespace`, so it works on `dynamo-kv` unchanged). The RunLog
      DO now holds only the ledger and projections and is deleted at the end of
      P5; `oauth-purge` stays for P5 (both user decisions)._

**Gate:** folders ticked; the KV/R2 rows of `aws/frozen-keys` are green;
node-unit has no new failures.

---

## P5 — Orchestration: Temporal

**Goal:** every durable or scheduled path is a Temporal workflow; every write
from the front door is a Start, Signal or Update. **Entry check:** P4 `[x]`;
Temporal test env works (P0 spike B).

| Folder / files                                                                           | CF-coupled / total | Done |
| ---------------------------------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/jobs`                                                                        | 9 / 15             | [x]  |
| `worker/src/package-invocations`                                                         | 8 / 16             | [x]  |
| `worker/src/webhooks`                                                                    | 7 / 12             | [x]  |
| `worker/src/package-events`, `worker/src/scheduled`                                      | 1 / 2              | [x]  |
| `worker/src/billing` (StripePlanRefresh DO)                                              | 4 / 8              | [x]  |
| `worker/src/dr` (keep only logic that becomes an `ops` lane; delete D1 backup specifics) | 6 / 9              | [x]  |
| root `queue-handler`, `deferred-work`, `*-maintenance`, `maintenance-handler`            | subset             | [x]  |

Code (`packages/worker/src/temporal/`):

- [x] `ids.ts` — workflow-id builders exactly as in the target doc's workflow
      catalog. Every id starts with `userId`, except lanes and fan-out. _Also
      webhook deliveries (`{endpointId}:{deliveryId}`, as the catalog says)._
- [x] `codec.ts` — payload codec using `aws/kms-envelope.ts`, context
      `{ userId, namespace }`. Search attributes carry only `userId`, `surface`,
      `packageId` and `status`. _`userId` is the owner of the payload's
      workflow, from the SDK's serialization context (`search-attributes.ts`:
      `KodyUserId`, `KodySurface`, `KodyPackageId`, `KodyStatus`)._
- [x] `client.ts` — Temporal client factory; front door and MCP server use only
      this to write.
- [x] `worker.ts` — one worker per task queue: `app`, `platform`, `runtime`,
      `ops`.
- [x] Workflows, one file each, with activities in `activities/`:
  - `ExecuteRun`, `PackageInvocation`, `JobRun`
  - `PackageWorkflowRun` (replaces the Cloudflare Workflow in
    `package-runtime/package-workflows.ts`)
  - `WebhookDelivery`, `EventFanout`, `PublishPackage`, `HumanApproval`,
    `AccountDelete`
  - `McpServerConnection` (entity), `InboundEmail` / `OutboundEmail`
  - one maintenance lane as the pattern for the rest
- [x] Idempotency: the start path checks the idempotency table in
      `aws/dynamo-runs.ts` first (90-day contract), then relies on workflow-id
      uniqueness.
- [x] Replace the `JobManager` DO and `JOBS_DB` cron dispatch with Temporal
      Schedules. Queue consumers become workflow Starts, and `ctx.waitUntil`
      deferred work becomes fire-and-forget Starts.
- [x] Delete `queue-handler.ts`, `jobs/jobs-host.ts`,
      `billing/stripe-plan-refresh-do.ts`, `test-support/jobs-service*.ts`,
      `cloudflare-workflows-stub.ts` once unused. _The jobs-service test shim
      still has sandbox-fixture callers and remains until P6/P8; the other named
      runtime files are removed._

P5 proves orchestration, not the Runner or front-door migration. `ExecuteRun`
has a workflow implementation but its run-token acceptance stays red until P6.
Mail/MCP delegate to their existing backends until P6, and P7 owns external
entry wiring, production worker environments and namespace configuration.

**Gate:** acceptance `webhook-delivery`, `job-run` and `publish-package` are
green (publish may still use only the code-interpreter fake); folders ticked;
node-unit has no new failures.

---

## P6 — Sandbox: Runner, broker, egress proxy, storage cells

**Goal:** user code runs only through the Runner; every call back into Kody goes
through the broker; every outbound fetch goes through the egress proxy. **Entry
check:** P5 `[x]`.

| Folder / files                                                           | CF-coupled / total | Done |
| ------------------------------------------------------------------------ | ------------------ | ---- |
| `worker/src/mcp` (executor, fetch-gateway, capabilities); batches of ≤15 | 109 / 187          | [ ]  |
| `worker/src/package-runtime`                                             | 19 / 36            | [ ]  |
| `worker/src/package-retrievers`                                          | 3 / 3              | [ ]  |
| `worker/src/repo` (RepoSession → workflow + code interpreter)            | 25 / 53            | [ ]  |
| `worker/src/email` (Mailbox → Aurora + S3 + SES)                         | 49 / 62            | [ ]  |
| `worker/src/mcp-client` (McpClientHub → Aurora + vault)                  | 10 / 22            | [ ]  |
| root `storage-runner*` (6 files)                                         | 6 / 6              | [ ]  |

Code:

- [ ] `runner/run-token.ts` — mint (activity only) and verify (broker, egress).
      Carries user, run id, provenance stamps, expiry and a retriever flag;
      signed with HMAC using `RUN_TOKEN_SIGNING_KEY`.
- [ ] `aws/agentcore-runner.ts` — `InvokeAgentRuntimeCommand` with
      `runtimeSessionId` = hash(`stable_user_id` + rotation epoch), padded to
      ≥33 chars. It passes S3 keys, never bundle bytes.
- [ ] `runner/supervisor.ts` (POC, optional) — `node:http` `/invocations` +
      `/ping` on 8080 that hands off to the existing executor. Running real
      `workerd` inside is the target doc's risk #1, so it stays a spike box: [ ]
      tried `workerd` locally → result in log.
- [ ] `broker/handler.ts` — receives `kody.*` calls, verifies the run token on
      each call and runs the existing capability handlers. The `kody:runtime`
      transport switches from service-binding RPC to this handler.
- [ ] `egress/proxy.ts` — move the logic from `mcp/fetch-gateway.ts`
      (`KodyFetchGateway` DO) into a plain module. Add blocks for private
      ranges, the metadata IP and Kody hosts. Placeholder resolution uses the
      KMS and vault fakes.
- [ ] `storage-cell/cell.ts` — from `storage-runner.ts`: one `node:sqlite` file
      per `[userId, storageId]`, lease + fencing token in the leases table,
      broker is the only caller.
- [ ] `RepoSession` entity workflow (Updates for edit and commit, an idle timer,
      Continue-As-New) over the code-interpreter fake. It replaces
      `repo-session-do.ts`, `repo-session-index-do.ts` and `@cloudflare/shell`.
      For source repos, keep the existing `isomorphic-git` + msw artifacts
      handlers and re-point them as a CodeCommit fake.
- [ ] Mail: `mailbox-do.ts` → Aurora tables + S3 raw MIME + SES fake. The
      auto-pause rule moves into the `InboundEmail`/`DeliveryEvents` workflows.
- [ ] `McpClientHub` → Aurora registrations + vault + `McpServerConnection`
      workflow.
- [ ] `PackageRealtimeSession` DO → minimal DynamoDB-backed session state;
      WebSocket path stubbed (`// ponytail: realtime transport deferred`).
- [ ] Delete the replaced DOs, plus `test-support/repo-session-do.ts` and
      `repo-session-index.ts`. Also delete `module-graph.ts` if it is
      DO-specific and `run-kody-registry.ts` if it is binding-specific.

**Gate:** acceptance `execute-run`, `capability-broker`, `egress-proxy` and
`storage-cell` are green; folders ticked; node-unit has no new failures.

---

## P7 — Front door, MCP server, app edge on Node; e2e rewired

**Goal:** the app boots on Node with AWS adapters (fakes in tests); MCP e2e and
Playwright run without Wrangler. **Entry check:** P6 `[x]`.

Tests first:

- [ ] Rewrite the 5 `*.mcp-e2e.test.ts` to boot `front-door/server.ts` with
      `createTargetTestEnv()` instead of Wrangler; keep the OAuth + MCP
      handshake journeys.
- [ ] Rewrite `tools/e2e-web-server.ts`, `e2e/cloudflare-mock.ts` and
      `e2e/d1-utils.ts` to use the Node front door and PGlite, seeded with the
      documented seed users (`jane@example.com`, `kody@example.com`, password
      `ilikecode`). Keep only `smoke.spec.ts`, `signup-verify-connect.spec.ts`
      and `account-navigation.spec.ts` for the POC; mark the rest `[-]` with a
      reason.
- [ ] Root tests: `platform-worker.node.test.ts`,
      `runtime-worker-*.node.test.ts`, `index.workers.test.ts`,
      `origin-handler.*`, `mcp-auth*` → front-door / app-edge tests or delete
      per recipe.

Code:

- [ ] `front-door/env.ts` — `createAwsEnv()` builds the `env` the existing fetch
      handler expects from the AWS adapters (tests pass fakes).
- [ ] `front-door/server.ts` — `node:http` → Web `Request` → existing `index.ts`
      fetch handler → `Response`. Reads use `APP_DB_READER`; mutations use the
      Temporal client.
- [ ] MCP: replace `MCPBase extends McpAgent` (a DO) with a stateless handler,
      mapping `Mcp-Session-Id` to `runtimeSessionId` for the 2025 lane. In the
      POC it runs in-process behind `/mcp`; AgentCore hosting is infra only.
- [ ] App edge: move the `{user}.kody.run` routing from
      `runtime-worker-routing.ts` into a handler that forwards to the Runner
      (direct invocation, per the POC default).
- [ ] Vite: drop `@cloudflare/vite-plugin` for client asset builds; front door
      serves `public/` from disk.
- [ ] Replace `worker-configuration.d.ts` with an `AwsEnv` type in
      `env-schema.ts`, and remove the `cloudflare:workers` /
      `cloudflare:workflows` stubs once nothing imports them. Keep the
      `@cloudflare/workers-oauth-provider` alias only if it is still used (log
      it).
- [ ] Remove deps: `wrangler`, `@cloudflare/vitest-pool-workers`,
      `@cloudflare/vite-plugin`, `@cloudflare/workers-types`,
      `@cloudflare/shell`, `agents` (if unused), and every `wrangler.jsonc`.

**Gate:** `mcp-e2e` is green; the Playwright smoke is green (fill its command in
section 4); acceptance `read-write-split` is green.

---

## P8 — Final sweep

**Entry check:** P7 `[x]`.

- [ ] The Cloudflare-reference gate (section 4) returns only allowlisted files.
      Write the allowlist with a reason for each entry.
- [ ] All 10 acceptance tests green.
- [ ] `CI=1 npx vitest run --project node-unit` — record totals; compare with
      baseline minus the Deleted tests log.
- [ ] Typecheck clean.
- [ ] `npx knip` — remove dead exports the migration left behind.
- [ ] Delete `test-support/create-d1-from-sqlite.ts`, `apply-all-migrations.ts`,
      `d1-retry.ts`, `d1-data-table-adapter.ts` and `d1-like-pattern.ts` (and
      their tests) once no importer remains (moved from P3).
- [ ] Update the flavour matrix in `docs/contributing/testing-principles.md`:
      drop `*.workers.test.ts` and describe `createTargetTestEnv()` and PGlite.
- [ ] Harvest `// ponytail:` comments into **Decisions and deviations**.

**Gate:** everything above ticked; final numbers in the Phase log.

---

## P9 — (Optional) CDK infra synth

- [ ] A `packages/infra` CDK app (TypeScript), account `000000000000`, region
      `us-east-1`, containing:
  - a VPC whose sandbox subnets have no NAT route
  - Aurora Serverless v2
  - the DynamoDB tables from section 3
  - S3 buckets
  - ECS services
  - an AgentCore Runtime (`aws-bedrockagentcore` L1)
  - a KMS key
- [ ] One `aws-cdk-lib/assertions` test checking that:
  - sandbox subnets have no route to the internet
  - only the egress task role has `kms:Decrypt`
  - the Runner role has no S3, KMS or database permissions
- [ ] Never `cdk deploy`.

---

## Phase log

| Phase    | Date       | node-unit pass / fail / skip                 | Acceptance green | Notes                                                                                                                                                                                                                              |
| -------- | ---------- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline | 2026-09-30 | 3,624 / 2 / 0                                | —                | Node v26.10.0; 1,088 files passed and 2 failed; workers-unit reference unresolved (see P0).                                                                                                                                        |
| P0       | 2026-09-30 | 3,624 / 2 / 0                                | —                | PGlite RLS, Temporal time skipping, AgentCore SDK and worker typecheck passed; `validate` has checkout and existing gate failures.                                                                                                 |
| P1       | 2026-09-30 | 3,282 / 2 / 0                                | —                | 342 baseline passes removed with Cloudflare-only packages/tooling; no new node failures. Worker typecheck, lint, Knip, primitives pass.                                                                                            |
| P2       | 2026-09-30 | 3,292 / 12 / 0                               | 0 / 10           | Ten fake tests pass; ten acceptance tests fail only at `not implemented`; two baseline failures remain. `validate` still fails on these and existing checkout gates.                                                               |
| P3       | 2026-09-30 | 3,299 / 12 / 0                               | 0 / 10           | In progress: schema, RLS and adapters; first identity/root test batch. Same twelve expected failures. Additional cascade case passed in the subsequent scoped gate.                                                                |
| P3       | 2026-09-30 | 3,303 / 12 / 0                               | 0 / 10           | In progress: RBAC/account creation and PGlite permission/email journeys. No new failures; three fewer tests from journey consolidation.                                                                                            |
| P3       | 2026-10-01 | 3,305 / 12 / 0                               | 0 / 10           | In progress: platform feedback, feature flags and banners/security/Discord/OIDC rows ticked; `kody_analytics` role. Validate red only on known blockers.                                                                           |
| P3       | 2026-10-01 | scoped: 136 / 10 / 0                         | 0 / 10           | In progress: `admin` row ticked (POC mode, targeted runs only). 51 PG-schema files: only the ten acceptance stubs fail. Admin + callers: 62 / 0.                                                                                   |
| P3       | 2026-10-01 | scoped: 307 / 1 / 0                          | 0 / 10           | In progress: `account` row ticked; `0008_account_subject.sql` subject roles. Account 82 / 0; 62 caller files 307 pass, only the `isolation` stub fails.                                                                            |
| P3       | 2026-10-01 | scoped: 460 / 10 / 0                         | 0 / 10           | In progress: `search-index` row ticked (renamed from `vectorize`); Bedrock-only embeddings, `0009_search_index.sql`. 119 files: only the ten stubs fail.                                                                           |
| P3       | 2026-10-01 | scoped: 722 / 1 / 0                          | 0 / 10           | In progress: `community` row ticked; `kody_community` public role, curator definers, admin moderation grants (`0010`). Community 90 / 0; 151 caller/PG files: only `isolation` stub fails.                                         |
| P3       | 2026-10-01 | scoped: 948 / 2 / 0                          | 0 / 10           | In progress: `package-registry` row ticked; grant-aware share RLS, account-directory definers, scope grants admin-only (`0011`). Folder 85 / 0; only `isolation` stub + known deploy.yml fail.                                     |
| P3       | 2026-10-01 | scoped: 1,390 / 10 / 0                       | 0 / 10           | In progress: `identity` row ticked; `app` batch 1 (11 files); pre-auth token and rate-limit definers (`0012`). 469 caller/PG files: only the ten acceptance stubs fail.                                                            |
| P3       | 2026-10-01 | scoped: 1,657 / 2 / 0                        | 0 / 10           | In progress: `app` batch 2 (7 files: 2FA, passkeys, password, email change/release, session); `0013` owner and email-in-use definers. 524 files: only `frozen-keys` + `isolation` stubs fail.                                      |
| P3       | 2026-10-01 | scoped: 1,660 / 2 / 0                        | 0 / 10           | In progress: `app` batch 3 (6 files: session, account/pending pages, profile, resend); RLS-hidden unique detail, delivery-index upsert. 525 files: only `frozen-keys` + `isolation` fail.                                          |
| P3       | 2026-10-01 | 3,339 / 11 / 0                               | 1 / 10           | Done: `app`, `universal`/`client` and root rows ticked; `0014`–`0016` + audit `0002`. Fails: nine acceptance stubs (P5–P7) and the two known checkout prerequisites.                                                               |
| P4       | 2026-10-01 | scoped: 31 / 1 / 0                           | —                | In progress (P3-independent part): six adapters + tests; frozen-keys KV/S3 rows pass, test still fails at the first postgres row (P3). Typecheck, oxlint, oxfmt, knip pass.                                                        |
| P4       | 2026-10-01 | 3,375 / 11 / 0                               | 1 / 10           | Done: `run-records` row ticked (RunLog run history → `RUN_RECORDS`); all P4 rows ticked; frozen-keys green. Fails: nine acceptance stubs (P5–P7) + two checkout prerequisites.                                                     |
| P5       | 2026-10-02 | scoped: 458 / 0 / 0; regressions: 66 / 0 / 0 | 4 / 10           | Done: all P5 rows ticked. Full validate snapshot: 3,394 pass / 17 fail; nine deletion-fixture failures fixed and rechecked in the final scoped run. Six P6/P7 stubs and two checkout failures remain. Final recovery check: 3 / 0. |
| P6       |            |                                              |                  |                                                                                                                                                                                                                                    |
| P7       |            |                                              |                  |                                                                                                                                                                                                                                    |
| P8       |            |                                              | 10 / 10          |                                                                                                                                                                                                                                    |

## Known failures (pre-existing at baseline)

- `tools/check-migrations.node.test.ts`: this checkout has no trusted Git base
  (`origin/main` history), so `checkMigrationsDirectory()` cannot verify the
  post-baseline ledger.
- `packages/worker/src/capability-maintenance.node.test.ts`:
  `.github/workflows/deploy.yml` is absent from this checkout.

## Deleted tests log

| Path                                                                                                                                     | Recipe rule | Reason                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/worker/src/dr/backup-s3.node.test.ts`                                                                                          | 1           | Retired Cloudflare backup-control-plane S3 transport; target backups are outside this POC.                            |
| `packages/worker/src/dr/dr-export-maintenance.node.test.ts`                                                                              | 1           | Retired Cloudflare staging/export maintenance endpoint.                                                               |
| `packages/worker/src/dr/dr-restore.node.test.ts`                                                                                         | 1           | Retired Cloudflare storage/R2/artifact restore mechanics.                                                             |
| `packages/worker/src/dr/exporter.node.test.ts`                                                                                           | 1           | Retired Cloudflare non-D1 staging and backup-control-plane export mechanics.                                          |
| `packages/worker/src/dr/mailbox-importer.node.test.ts`                                                                                   | 1           | Retired Cloudflare mailbox dump/import maintenance path.                                                              |
| `packages/worker/src/dr/mailbox-importer.workers.test.ts`                                                                                | 1           | Retired Cloudflare mailbox backup import and restore mechanics.                                                       |
| `packages/backup-control-plane/access-auth.node.test.ts`                                                                                 | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/backup-policy.node.test.ts`                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/backup-runtime.node.test.ts`                                                                              | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/control-plane-fetch.node.test.ts`                                                                         | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/control-plane-ui.node.test.ts`                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/d1-export-api.node.test.ts`                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/d1-import-api.node.test.ts`                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/durable-export.node.test.ts`                                                                              | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/freshness-check.node.test.ts`                                                                             | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/freshness-retry.node.test.ts`                                                                             | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/immutable-storage.node.test.ts`                                                                           | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/manifest-signing.node.test.ts`                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/production-restore.node.test.ts`                                                                          | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/restore-confirm-token.node.test.ts`                                                                       | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/restore-drill.node.test.ts`                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/seal-day-action.node.test.ts`                                                                             | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/seal-day-run.node.test.ts`                                                                                | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/seal-full-backup.node.test.ts`                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/workflow-step-boundary.node.test.ts`                                                                      | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/backup-control-plane/workflow-trigger.node.test.ts`                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/highlight-worker/src/index.node.test.ts`                                                                                       | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/highlight-worker/src/tokenize.node.test.ts`                                                                                    | —           | Moved with the Shiki tokenizer to packages/worker/src/highlight                                                       |
| `packages/jobs-worker/src/health.node.test.ts`                                                                                           | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/jobs-worker/src/scheduled.node.test.ts`                                                                                        | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/jobs-worker/src/service.node.test.ts`                                                                                          | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/nx-cache/handle-request.node.test.ts`                                                                                          | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/nx-cache/local-server.node.test.ts`                                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/nx-cache/memory-store.node.test.ts`                                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/nx-cache/r2-store.node.test.ts`                                                                                                | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/alert-email.node.test.ts`                                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/day-bars.node.test.ts`                                                                                                  | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/email-policy.node.test.ts`                                                                                              | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/execute-health.node.test.ts`                                                                                            | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/incident-events.node.test.ts`                                                                                           | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/incident-rollups.node.test.ts`                                                                                          | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/incidents.node.test.ts`                                                                                                 | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/probes.node.test.ts`                                                                                                    | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/provider-incidents.node.test.ts`                                                                                        | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/retire-public-audit-db.node.test.ts`                                                                                    | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/retrospective-maintenance.node.test.ts`                                                                                 | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/retrospective.node.test.ts`                                                                                             | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/status-page.node.test.ts`                                                                                               | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/status/worker.node.test.ts`                                                                                                    | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/worker/src/app/anonymous-html-edge-cache.workers.test.ts`                                                                      | 1           | Cloudflare runtime/cache/DO telemetry mechanics                                                                       |
| `packages/worker/src/deferred-work.workers.test.ts`                                                                                      | 1           | Cloudflare runtime/cache/DO telemetry mechanics                                                                       |
| `packages/worker/src/dr/do-pitr.workers.test.ts`                                                                                         | 1           | Cloudflare runtime/cache/DO telemetry mechanics                                                                       |
| `packages/worker/src/repo/artifacts-mock-cloudflare.node.test.ts`                                                                        | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/worker/src/test-support/cloudflare-mock-server.node.test.ts`                                                                   | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `packages/worker/src/usage/durable-object-duration-attribution.workers.test.ts`                                                          | 1           | Cloudflare runtime/cache/DO telemetry mechanics                                                                       |
| `packages/worker/universal/highlight-cache-request.node.test.ts`                                                                         | 1           | Deleted Cloudflare-only sibling package or mock server                                                                |
| `tools/check-deploy-guardrails.node.test.ts`                                                                                             | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/check-origin-production-exports.node.test.ts`                                                                                     | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/check-worker-startup-bundles.node.test.ts`                                                                                        | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/check-worker-startup-time.node.test.ts`                                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/backup-resources.node.test.ts`                                                                                                 | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/execute-interpretable-telemetry-config.node.test.ts`                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/is-retryable-deploy-failure.node.test.ts`                                                                                      | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/mcp-search-telemetry-config.node.test.ts`                                                                                      | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/nx-cache-resources.node.test.ts`                                                                                               | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/onboarding-funnel-telemetry-config.node.test.ts`                                                                               | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/origin-production-deploy-state.node.test.ts`                                                                                   | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/package-invoke-telemetry-config.node.test.ts`                                                                                  | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/platform-worker-config.node.test.ts`                                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/preview-resources.node.test.ts`                                                                                                | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/production-queue-resources.node.test.ts`                                                                                       | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/reset-migration-bookkeeping.node.test.ts`                                                                                      | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/runtime-worker-config.node.test.ts`                                                                                            | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/ci/sync-worker-secrets.node.test.ts`                                                                                              | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/deploy.node.test.ts`                                                                                                              | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/canonical-readiness-signatures.node.test.ts`                                                                    | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/restore-cli-and-staging.node.test.ts`                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/restore-drill-execution.node.test.ts`                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/restore-trust-and-verification.node.test.ts`                                                                    | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/restore-wrangler-contract.node.test.ts`                                                                         | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/disaster-recovery/seal-escrow.node.test.ts`                                                                                       | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/local-d1-persist.node.test.ts`                                                                                                    | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/local-dev-migrations.node.test.ts`                                                                                                | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/nx-cache-contract.node.test.ts`                                                                                                   | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/nx-remote-cache-smoke.node.test.ts`                                                                                               | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/origin-vite-startup-build.node.test.ts`                                                                                           | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/origin-worker-config.node.test.ts`                                                                                                | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/seed-test-data.node.test.ts`                                                                                                      | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/sentry-upload-sourcemaps.node.test.ts`                                                                                            | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/vite-worker-whole-graph-reload.node.test.ts`                                                                                      | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/worker-additional-module-allowlist.node.test.ts`                                                                                  | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/wrangler-deploy-retry.node.test.ts`                                                                                               | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/wrangler-env-config.node.test.ts`                                                                                                 | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `tools/wrangler-filter-kody-generated-watch.node.test.ts`                                                                                | 1           | Deleted Cloudflare deploy, DR, or worker-pool tooling                                                                 |
| `packages/worker/src/search-index/embedding.node.test.ts` (2 AI Gateway cases)                                                           | 1           | Workers AI Gateway batching/fallback; Bedrock port replaces it                                                        |
| `packages/worker/src/app/account-deletion.node.test.ts` (column coverage case)                                                           | —           | Duplicate of the PostgreSQL schema coverage in `account/data-targets.node.test.ts`                                    |
| `packages/worker/src/entitlements/user-meter.workers.test.ts`                                                                            | 3 / 1       | Behaviour moved to `user-meter.node.test.ts`; schema-upgrade and `blockConcurrencyWhile` cases are DO mechanics       |
| `packages/worker/src/entitlements/entitlements-service.workers.test.ts`                                                                  | 3           | Rewritten as `entitlements-service.node.test.ts`                                                                      |
| `packages/worker/src/entitlements/d1-storage-reconciliation.workers.test.ts`                                                             | 3           | Rewritten as `d1-storage-reconciliation.node.test.ts`                                                                 |
| `packages/worker/src/storage-buckets/service.workers.test.ts`                                                                            | 3           | Folded into `storage-buckets/service.node.test.ts`                                                                    |
| `packages/worker/src/usage/record-usage.workers.test.ts`                                                                                 | 3           | Folded into `usage/record-usage.node.test.ts`                                                                         |
| `packages/worker/src/usage/durable-object-rows-read.workers.test.ts`                                                                     | 1           | StorageRunner DO rows-read billing telemetry in workerd                                                               |
| `packages/worker/src/oauth-helpers.workers.test.ts`                                                                                      | 1           | Deferred provider-module loading in workerd; grant list/revoke covered by `oauth-helpers.node.test.ts` on `dynamo-kv` |
| `packages/worker/src/sentry-options.node.test.ts` (Workers KV 5xx/429 block)                                                             | 1           | Workers KV binding error strings; the filter and `cloudflare-kv-platform-error.ts` are gone                           |
| `packages/worker/src/run-records/run-records.workers.test.ts` (alarm lifecycle, over-cap backoff, `run_log_meta` cache, `log_count` SQL) | 1           | DO alarm/meta-cache/SQLite mechanics; the behaviour cases moved to `run-records.node.test.ts`                         |
| `packages/worker/src/run-records/run-records.workers.test.ts` (remaining cases)                                                          | 3           | Folded into `run-records.node.test.ts`; the sandbox-logs case moved to `sandbox-logs.workers.test.ts` (P6)            |
| `packages/worker/src/run-records/continuity-and-retention.workers.test.ts`                                                               | 3           | Folded into `dedicated-state.node.test.ts`; projection retention moved to `dedicated-state.workers.test.ts` (P5)      |
| `packages/worker/src/run-records/dedicated-state.workers.test.ts` (schema v11 and v7–v10 upgrade cases)                                  | 1           | DO schema migrations; the run store has no schema versions                                                            |
| `packages/worker/src/run-records/dedicated-state.workers.test.ts` (SQL billing stats, inspection)                                        | 1           | DO SQLite rows-read billing for `listRuns`, which no longer runs in the DO                                            |
| `packages/worker/src/run-records/dedicated-state.workers.test.ts` (job, activation, retention, export, admin insights)                   | 3           | Folded into `dedicated-state.node.test.ts` against `RUN_RECORDS`                                                      |
| `packages/worker/src/mcp/capabilities/runs/runs.workers.test.ts`                                                                         | 3           | Renamed to `runs.node.test.ts` over the run-store fakes                                                               |

## P3 batch log

- **Entry check (2026-09-30):** P2 typecheck passed. All ten fake self-tests
  passed with local loopback enabled for Temporal. All ten acceptance files
  failed at their intended `not implemented` stubs. Full node-unit: 3,292 passed
  / 12 failed / 0 skipped, exactly the P2 baseline (ten stubs and the two known
  checkout failures).
- **Foundation batch:** translated the final application and job-config schema,
  RLS, restricted admin grants and builtin indexing, pool/PGlite facade,
  pgvector/full-text adapter, Bedrock embedding port and target-env bindings.
  The final scoped gate passes all 21 tests across 15 files (including all ten
  P2 fake tests). Typecheck, lint, Knip, primitives, lockfile, docs and
  file-size checks pass. New behavioral tests cover these boundaries. The schema
  generator in `tools/pg/` was deleted after the squash.
- **Identity/root batch 1 (two existing test files):** permission-seed parity
  uses the PostgreSQL baseline; `database-errors.node.test.ts` exercises real
  unique violations, and `database-errors.ts` reads PostgreSQL diagnostics.
- **Audit/banner batch (two existing persistence test files):** separate audit
  schema, append-only/read-only roles and connection pools; audit queries retain
  filters and pagination. The target environment binds a separate audit
  instance. The banner service now runs on PGlite with operator writes, per-user
  dismissal RLS, conflict-safe repeat dismissal and delete cascades. Both tests
  were red before implementation (missing audit factory and missing operator
  privileges).
- **Feature flag batch (two existing test files):** removed the handwritten SQL
  emulator from `service.node.test.ts` and ran its behavior checks on PGlite.
  Added ordinary-role denial and exposure-counter journeys. Red tests caught
  missing operator grants, SQLite numbered placeholders and an ambiguous upsert
  counter. Service and exposure persistence are green; metric readout and
  Analytics Engine replacement remain unchecked.
- **App/security batch (two existing test files):** the login persistence
  journey writes to the new audit sink (app auth fixture still SQLite); the new
  Postgres-only isolation acceptance case passes for application rows, account
  rows and child secrets. The full account-access journey remains intentionally
  red. Existing MCP audit calls use the public prepared-query type.
- **Operator regression follow-up (two existing HTTP/MCP test files):** the full
  run found an HTTP flag SQL emulator pinned to the previous bind indexes.
  Replaced both HTTP and MCP flag emulators with the shared PGlite fixture; the
  MCP journey persists its audit records in the separate audit database. All
  three operator journey tests pass on rerun. Metrics are explicitly unavailable
  in these mutation fixtures until the analytics batch lands; no broader SQL
  privilege was added for metric readout.
- **Continuation checks:** 32 scoped tests across nine files passed; the
  PostgreSQL isolation acceptance case passed separately. Full node-unit
  discovered 3,302 pass / 13 fail / 0 skip: the twelve established failures plus
  the HTTP fixture failure corrected above. The follow-up two-file run passes
  all three tests. The full suite was not rerun after that fixture-only rewrite.
  Typecheck, lint, Knip, primitives, docs, formatting and file-size checks pass.
- Remaining folder batches, production environment construction, SQL caller
  conversion and legacy-helper removal are unchecked. Details:
  [P3 relational store foundation](../docs/migration/p3-relational-store.md).
- **Identity activation/background batch (2026-09-30):** replaced the activation
  and first-search SQL emulators with the shared PostgreSQL baseline, and moved
  the background identity Workers tests into the Node pool. Three activation
  checks failed before the PostgreSQL parameter/date conversion. The journeys
  now cover all six first-seen stamps, concurrent first-search claims, UTC days
  under a non-UTC database timezone, reader write denial and cross-user RLS. A
  further red case exposed unverified background execution; the shared resolver
  now rejects unverified accounts and evicts that rejected lookup so
  verification takes effect immediately. Role and permission reads use scoped
  PostgreSQL roles. The identity suite passes 29 tests across 18 files; the
  final caller regression passes 193 tests across 54 files. Typecheck passes.
  The P2 entry harness also passed all 15 tests across 11 files with local
  Temporal loopback enabled. RBAC mutation SQL and the remaining identity/app
  fixtures are still unchecked.

- **Identity batch validation:** `npm run validate` ran: full node-unit 3,306
  passed / 12 failed / 0 skipped. The failures are the ten established
  acceptance stubs and two checkout prerequisites (migration Git history and
  missing deploy workflow). Lint, typecheck, Knip, primitives, docs, Mermaid,
  file-size and lockfile checks pass. Formatting debt in eight untouched files
  and six dependency advisories also keep the aggregate gate red. Changed files
  pass formatting; the final scoped regression and typecheck also passed after
  the verification guard was added.

- **RBAC/account-creation batch (2026-09-30):** converted the creation and
  persistence journeys to the shared PostgreSQL baseline first (four red tests).
  Role assignment now uses `ON CONFLICT`; account inserts use `RETURNING id`.
  Former-email reservations and app permissions run on PGlite. The batch touches
  thirteen implementation/test/schema files; documentation records the scope
  separately. `0005_identity_administration.sql` permits authorized account
  allocation to read email reservations and prevents ordinary writer
  self-promotion. Account claims and setup tokens use the new user's scoped
  writer, without granting the admin role token access. Failed default-role
  writes now clean up the inserted account, matching claim/token failure
  cleanup. PostgreSQL last-admin removal locks the admin role before counting in
  a fresh statement snapshot. PGlite checks the invariant but does not prove
  multiple-connection contention. Production environment wiring remains
  unchecked.
- **Caller-fixture follow-up (four files):** updated existing admin/auth SQL
  doubles for `INSERT ... ON CONFLICT` and returned insert IDs. These broader
  handler/capability fixtures still await full PGlite conversion. Updated the
  signup comment to match the new role assignment SQL. Scoped caller regression:
  94 passed across 27 files; typecheck passes. Full validation: 3,303 passed /
  12 failed / 0 skipped. Consolidating the migrated journeys reduces the test
  count by three; the same ten acceptance stubs and two checkout-prerequisite
  failures remain. Typecheck, lint, Knip, primitives, docs, Mermaid, ratchets
  and lockfile checks pass. The aggregate gate remains red on those tests,
  missing migration Git history, formatting debt in eight untouched files and
  six existing dependency advisories. Touched files pass formatting; the
  documentation check passed again after note edits.

- **Remix query/auth-fixture batch (2026-09-30):** eight implementation/test
  files. A red integration check found the shared adapter querying
  `sqlite_master` on PostgreSQL. `createDb` now recognizes the PostgreSQL facade
  and delegates the installed Remix PostgreSQL driver's queries back through its
  scoped transaction. Coverage includes generated IDs, returned account rows,
  case-insensitive lookup, reader and cross-user denial, and rollback. The login
  audit, stable-ID signup conflict, generated username and paged reserved-name
  journeys now use the shared PostgreSQL baseline. The account allocation
  fixtures use the restricted admin role; login uses the selected account's
  writer. They do not prove production pre-authentication wiring. Scoped
  regression: 69 tests across 27 files pass; final driver checks: 2 pass. P2
  harness entry checks: 14 tests plus the local Temporal self-test pass.
  Typecheck and touched-file lint/format checks pass. Full validation: 3,305
  passed / 12 failed / 0 skipped, with the same ten acceptance stubs and two
  checkout-prerequisite failures. Typecheck, lint, Knip, primitives, docs,
  Mermaid, ratchets and lockfile checks pass. The aggregate gate remains red on
  those tests, missing migration Git history, formatting debt in eight untouched
  files and six dependency advisories. The final documentation check passes
  after removing rollout wording. Provider signup, successful password signup
  and request/activity environment construction remain unchecked.

- **Platform feedback / Discord / OIDC / flag readout batch (2026-10-01):**
  completes three folder rows. Entry check matched the log: typecheck passed and
  the scoped P2/P3 run had only the `frozen-keys` and full `isolation` stubs
  failing. Platform feedback service and admin loader tests use PGlite:
  submitters write through scoped writers (forged attribution hits RLS),
  `kody_admin` reviews but cannot author or rewrite content. Discord membership
  and role sync and OIDC UserInfo read through the subject's scoped reader;
  other users' readers and unverified subjects are refused. Their SQL was
  already PostgreSQL-compatible, so these tests passed at runtime on first run;
  the source change was the `SqlDatabase` query shape. The flag metric readout
  uses the new read-only `kody_analytics` role (`0006_operator_analytics.sql`);
  three readout tests failed without the migration and pass with it. Seeded
  out-of-window rows replace the old bind-parameter assertions. The feedback
  schema fixture was deleted. The subscription Workers suite moved to P6.
  `status-incidents` has no SQL; its `Env` placeholders wait for P7. Eight
  implementation/test files plus one migration and the facade role list changed.
  Scoped regression: feature-flags/aws 32 pass (plus the `frozen-keys` stub);
  identity/discord/oidc/status-incidents 58 pass; platform feedback and callers
  19 pass. Converted tests also type-check under a temporary test-inclusive
  config (since deleted). Typecheck, lint (0 errors), Knip, primitives and
  touched-file formatting pass. Full node-unit: 3,305 passed / 12 failed / 0
  skipped, the same ten acceptance stubs and two checkout prerequisites.

- **Admin batch (2026-10-01, POC mode):** completes the `admin` row; all seven
  CF-coupled test files run on PGlite (three regex SQL emulators and two SQLite
  fixtures removed). Role per surface: fleet insights (`launch-signals`,
  `fleet-usage-insights`, `insights-runlog-snapshot`) read through
  `kody_analytics`, extended by `0007_admin_insights.sql` with column grants on
  account labels/plan/activation stamps, roles, feedback status and wallet
  balance; email, profile text and feedback content stay denied. Mailbox
  retention lists owners through `kody_admin`. Per-account reports
  (`user-meter-parity`, `user-usage-data`) read through the subject's scoped
  reader; another account's reader gets `null`. One real red: PostgreSQL folded
  the unquoted `AS userId` alias, so retention fanned out with
  `ownerId: undefined`; the alias is now quoted. The invalid-stored-plan case
  now asserts the schema CHECK rejects the row (the state is unrepresentable on
  PostgreSQL). Other SQL was already compatible (`date(text)` casts work on UTC
  stamps). `entitlement-consumption` keeps its `{}` placeholder (mock-only).
  Checks: admin + callers 62 pass / 13 files; all 51 PG-schema test files 136
  pass with only the ten acceptance stubs failing; worker typecheck, oxlint,
  oxfmt clean; converted tests add no type errors over the pre-existing ones
  (temporary config, deleted). Full node-unit and validate not run (POC mode).

- **Account batch (2026-10-01, POC mode):** completes the `account` row. Entry
  check: worker typecheck passed; the account suite was 75 / 0 on SQLite.
  Per-user RLS hides the attribution rows account deletion anonymizes and export
  reads (grants a user made, reviews, bans, lease repairs, codemod filters), so
  the one-batch deletion would silently leave the subject's id behind. User
  decision: dedicated subject roles. `0008_account_subject.sql` is generated
  from `accountUserDataTargets` (generator deleted): `kody_subject_reader`
  selects exactly the export inventory rows, `kody_subject_purger`
  selects/deletes every inventory row for `app.user_id`. PostgreSQL makes an
  UPDATE's new row pass SELECT policies, so RLS cannot let the purger rewrite
  the column that made a row visible (verified on PGlite). The ten non-delete
  targets therefore run in `kody_subject_anonymize()`, a `SECURITY DEFINER`
  function owned by NOLOGIN `kody_subject_anonymizer`, bound to the caller's own
  subject and executable only by the purger; `deleteUserScopedRowsAndUser` calls
  it first in the same atomic batch on PostgreSQL. Reds before the fixes: four
  lease-repair tests (`INSERT OR IGNORE`), the writer-cannot-purge and
  purger-anonymization checks, the storage-runner count (job storage ids
  `undefined` from the unquoted `AS storageId` alias), and export rows denied on
  `jobs`. Export pages by each table's catalog primary key (JSON tuple cursors)
  instead of SQLite `rowid`; R2 scans key on `id` (signed cursor v4, older
  cursors restart). The JSON substring predicate is
  `length(replace(...)) < length(...)`, valid on both dialects, so the admin
  purge capability test (still SQLite until P7 env wiring) keeps passing.
  Unverified-account purge lists/claims through `kody_admin` (new
  `oauth_connections.user_id` column grant) and deletes through an injectable
  `subjectEnv`; timestamp comparisons use a portable UTC-second text expression.
  The facade now refuses `set_config` in prepared SQL, which could otherwise
  rebind `app.user_id` mid-transaction. Unquoted camelCase aliases in the jobs
  repos and storage-bucket service are quoted. Checks: account 82 / 0 (8 files
  with `pg-database`); 62 caller files 307 pass, only the `isolation` acceptance
  stub fails; worker typecheck, oxlint (0 errors) and oxfmt pass; converted
  tests add no new type errors (temporary config, deleted). Full node-unit and
  validate not run (POC mode).

- **Search index batch (2026-10-01, POC mode):** completes the `vectorize` →
  `search-index` row. Entry check: worker typecheck passed; the folder and `aws`
  suites matched the log (only the `frozen-keys` stub failed). A caller baseline
  found one regression from the account batch:
  `package-registry/service.node.test.ts` (8 tests) emulated the unquoted
  `AS storageId` alias that batch had quoted; the fixture now matches the quoted
  alias. Moved the folder; 39 importers, the import-boundary test,
  `primitives.yaml` and four docs now use `#worker/search-index/*`. Exported
  names (`embedTextsForVectorize`, `vectorizeMaxIdBytes`, …) are unchanged.
  Tests first: the embedding suite drives the Bedrock `EmbeddingPort` (bounded
  batches, truncation, order, count and dimension checks, production refusal
  without a port); the fingerprint journey runs on PGlite with the real pgvector
  index, a user writer, another account's writer and the builtin `kody_indexer`.
  Reds: Workers AI was still required and its 384-d vectors were rejected by
  `search_vectors`. Embeddings now come only from `BEDROCK_EMBEDDINGS` (Titan
  v2, 1,024-d); the Workers AI / AI Gateway path and its two gateway tests are
  deleted. `getCapabilityVectorIndex` returns the pgvector `SearchIndex` type
  and prefers `SEARCH_INDEX`, falling back to legacy `CAPABILITY_VECTOR_INDEX`
  doubles until P7. Reindex helpers accept `Pick<SearchIndex, 'upsert'>`.
  `0009_search_index.sql` lets `kody_indexer` keep builtin fingerprints only;
  before it, builtin reindex could never skip under RLS. Fingerprints follow
  owner RLS, so deletion by `vector_id` no longer reaches other accounts' rows.
  Four mcp tests swapped Workers AI embedding stubs for the port. Checks: 119
  files (callers, account, package-registry, community and every PG-schema test)
  460 pass, only the ten acceptance stubs fail; worker typecheck clean apart
  from the parallel P4 session's in-progress `aws/s3-objects.ts`; oxlint (0
  errors), oxfmt, Knip pass; converted tests add no new type errors (temporary
  config, deleted). Full node-unit and validate not run (POC mode).

- **Community batch (2026-10-01, POC mode):** completes the `community` row.
  User decision: a dedicated read-only `kody_community` role for the fourth
  documented exception (public listing metadata), over public SELECT policies on
  the ordinary roles or reusing `kody_admin`. `0010_community_public.sql` grants
  it active listings and the ratings/forks/activity on them, public
  (`is_private = 0`) saved packages and their sources, public profile columns,
  ban rows, redirects, and webhook/job counts of public packages. Column grants
  deny email, credentials, rating notes and report content.
  `getCommunityDb(env)` prefers `COMMUNITY_DB` and falls back to `APP_DB` until
  P7. Browse, search, overview, featured, profile, package-URL resolution and
  fork/rate/report preflights read through it; ban checks too, because a
  delegated actor's ban row is invisible to the owner's writer. Owner writes
  stay on `APP_DB`. Moderation (feature, report resolution, ban, delist/delete,
  orphan cleanup, activity review) gets `kody_admin` grants; the unused
  `public_community_*` views are dropped. Three owner actions touch other users'
  rows: unpublish clears ratings/activity, republish re-points orphaned forks,
  and a username claim clears the claimed name's retirement row. Each runs in a
  `SECURITY DEFINER` function owned by NOLOGIN `kody_community_curator`, bound
  to the caller's own listing or current username. A first attempt with owner
  DELETE policies was red: PostgreSQL checks DELETE predicates against SELECT
  policies, so the claim delete matched nothing (and ratings would have exposed
  notes). Unpublish now clears engagement before deleting the listing
  (`deleteOwnedCommunityListingEngagement`). Other reds: a plpgsql parameter
  named like a `community_forks` column was ambiguous. SQLite-isms: `LIKE` token
  filters now compare `lower(column)`; redirect timestamps are bound instead of
  `strftime`. `findPublicUserIdentityByUsername` selects email, so package-URL
  resolution reads `username, stable_user_id` itself; `UserSocialRow` drops the
  unused email. Tests: four SQLite fixtures (`listings-by-ids`,
  `index-overview`, `orphan-forks`, `activity-service`) and two Workers suites
  (`package-url`, `profile-service`, renamed to `*.node.test.ts`) run on PGlite
  via `test-support/aws/test-community-db.ts`, with new cases for column denial,
  read-only refusal, cross-user writer denial, the three definers and private
  package non-resolution. Community signatures, `package-registry/repo.ts` and
  `getEntitySourceById` take `SqlDatabase`. Deferred, not run today:
  `community-flow.workers.test.ts` (capability end-to-end through Artifacts, KV
  snapshots and the bundler) to P6, `community-icon.workers.test.ts` (R2/KV/
  Images) to P4/P7, and `og-image.workers.test.ts` (workerd `ASSETS`; Node
  rendering is covered by `og-image.node.test.ts`) to P7.
  `friendly-url-migration.node.test.ts` is pure SQLite migration history
  (rule 7) and goes with the D1 migrations in P8. Mock-only `{} as D1Database`
  placeholders stay until P7. Checks: community 28 files 90 / 0; 151
  caller/PG-schema files 722 pass, only the `isolation` acceptance stub fails;
  worker typecheck, oxlint (0 errors) and oxfmt pass. Full node-unit and
  validate not run (POC mode).

- **Package-registry batch (2026-10-01, POC mode):** completes the
  `package-registry` row. User decision: grant-aware RLS plus definers for share
  grants (over a broad `kody_share` role or deferring).
  `0011_package_registry.sql`: a pending or accepted grant shows the guest the
  owner's saved package and source; the policy reads grants under the caller's
  own RLS. Grant rows were forgeable: the `0002` policy let a grantee insert or
  update any grant naming themselves, which the new visibility policy would have
  turned into reading any package. Red first: the new isolation test revived a
  revoked grant and read the package. Now only owners insert/delete (own id),
  guests update only their pending/accepted grant (status/trust/timestamps;
  UPDATE is column-granted so nobody moves a grant's package or owner), and
  unbound email invites are visible/claimable only by the matching verified
  email. `kody_account_directory` owns four definers: `kody_share_find_invitee`
  (exact username, or exact person email), `kody_share_peer` (the other party of
  a visible grant, with entitlement columns for plan checks; email only to an
  owner about their grantee), and `kody_platform_account(_usernames)` for
  platform scopes. `share-grants.ts` (`findSharePeer`, invitee lookup, peer plan
  via `resolveUserPlanFromRow`) and `scope-grants.ts` call them on Postgres and
  keep SQLite queries for legacy bindings; share invite email delivery uses
  `findSharePeer`. Same forgery class on `package_scope_grants` (a person could
  grant themselves `@kody`): writers now only read their grants; `kody_admin`
  creates/removes them. Unique-violation detection uses
  `getUniqueConstraintField` (both dialects). `COLLATE NOCASE` name sort is
  `LOWER(name)`. Tests: `share-grants` (one SQLite DB for every party → each
  party's writer, flag toggled as `kody_admin`; three "not addressed" cases now
  see RLS's "no pending invitation"; new case: invisibility to outsiders,
  revocation, revive/forge refusal, peer email rules),
  `delete-package-community- forks`, `platform-package-policy`,
  `source-row-batch`, `search-index-debt` (the cross-owner upsert is now an RLS
  refusal; coalescing kept with one owner) on PGlite; `package-owner` and
  `repo-search` Workers suites renamed to node. Deferred:
  `service.node.test.ts`'s entitlement emulator (UserMeter/storage recompute, P4
  `entitlements`), `source.node.test.ts` (KV, P4), `package-reindex-d1-retry`
  (goes with `d1-retry.ts`); `user-scope` is a no-email spy (rule 6). Checks:
  package-registry 21 files 85 / 0; 200 caller/PG-schema files 948 pass, 2 fail
  (the `isolation` stub and the known missing `deploy.yml`); worker typecheck,
  oxlint (0 errors), oxfmt, knip pass. Full node-unit and validate not run (POC
  mode).

- **Identity tail + app batch 1 (2026-10-01, POC mode):** ticks `identity`; 11
  `app`/`identity` test files leave SQLite. Entry check: worker typecheck
  passed; identity + app were 194 files 589 / 0. User decisions: pre-auth token
  links resolve their owner through definers, and `_rate_limits` lives in
  PostgreSQL behind definers. `0012_pre_auth_tokens_rate_limits.sql`: NOLOGIN
  `kody_token_resolver` owns `kody_password_reset_owner(hash)` and
  `kody_email_verification_owner(hash)`, which return only the owner's stable
  id. `identity/token-owner-db.ts` (`resolveTokenOwnerDb`) then continues on
  that owner's writer from `APP_DB_FOR_USER`. On PostgreSQL it throws without
  the factory instead of failing silently. NOLOGIN `kody_rate_limiter` owns
  `kody_rate_limit_take/release`, each behind a per-key transaction advisory
  lock. Runtime roles have no table grants, and readers cannot execute either
  definer. `checkRateLimit` no longer runs DDL on PostgreSQL. Admin email
  verification stamps `users` as `kody_admin`, which has no token access, and
  writes tokens through the target's writer (`forUser`). Password-reset confirm,
  `/verify-email` and the tips unsubscribe link use the owner's writer. Reds
  before the fixes: `COLLATE NOCASE` in admin target lookup, PG-hidden
  reset/verify tokens (confirm returned 400, `expired_token` read as
  `invalid_token`), runtime DDL in the rate limiter, and SQLite scalar
  `MAX(a, b)` in the usage campaign upsert. That upsert is now a portable
  `CASE`; campaign sends and tips opt-outs use `ON CONFLICT DO NOTHING`. The
  admin list `q` filter compares `lower(column)`. The verify stamp binds its
  `updated_at`; with `CURRENT_TIMESTAMP`, PostgreSQL would store its own text
  form. Converted: `identity/email-verification-admin`, `app/rate-limit`,
  `email-verification` (its SQL emulator removed), `apply-password-change` (a
  privilege revoke replaces `DROP TABLE`, and a definer trigger records the
  stamp), `email-verification-stall-alerts` (fleet scan as `kody_admin`; an
  ordinary writer scans nothing), `discord-page-data`, `user-account-emails`,
  and the handler suites `password-reset-confirm`, `account-email-destinations`
  and `unsubscribe-tips`. New cases cover bystander factors surviving a reset,
  pre-auth writers seeing no tokens, and another account's Discord link or
  opt-out staying invisible. The `admin-users` and `admin-capabilities` SQL
  doubles were updated for the new filter SQL. Deferred:
  `connect-oauth-chooser`, `account-integrations-data` and
  `account-mcp-oauth-clients` go to P4 `integrations`/`oauth-*`.
  `user-usage-campaign-emails` (a fleet sweep calling per-user writes) waits for
  per-subject environments. Checks: 469 caller/PG-schema files 1,390 pass, and
  only the ten acceptance stubs fail. Worker typecheck, oxfmt and oxlint pass (0
  errors; the two warnings in `admin-users` are pre-existing). Full node-unit
  and validate were not run (POC mode).

- **App batch 2: signed-in account security (2026-10-01, POC mode):** seven
  `app` test files leave SQLite: `two-factor`, `passkeys`, `account-password`,
  `account-email-change`, `account-email-claim-release`, `session-handler` and
  `session-info` (the last two drop their regex SQL emulators). Entry check:
  worker typecheck passed; the seven files were 23 / 0 on SQLite. User
  decisions: signed-out entry points resolve their owner through more
  `kody_token_resolver` definers, and the email-in-use check is a boolean
  `kody_account_directory` definer. `0013_account_security.sql` adds
  `kody_email_change_owner`, `kody_email_claim_release_owner` and
  `kody_passkey_owner` (stable id only), and
  `kody_email_reserved_for_other(email, except_user_id)`, which mirrors
  `isEmailReservedForOtherAccount` and is executable by `kody_writer` and
  `kody_admin`; readers can execute none of them. `resolveTokenOwnerDb` takes
  the new kinds (its `tokenHash` field is now `key`). The email-change and
  former-email release links continue on `APP_DB_FOR_USER`. Passkey sign-in
  resolves the credential's owner, then reads the passkey, bumps the counter and
  stamps activity on that owner's writer. 2FA verify uses the account the signed
  pending cookie names. Passkey registration relies on the insert's unique
  violation (409) because RLS hides other accounts' credentials.
  `isEmailReservedForOtherAccount` calls the definer on PostgreSQL. Reds before
  the fixes: passkey sign-in reported "not recognized" on the pre-auth writer;
  2FA verify returned 400; an email change to another account's address
  returned 200. Dialect fixes: `CURRENT_TIMESTAMP` assignments in passkeys and
  the email-change stamp are bound `utcSqliteTimestamp()` values; the 2FA setup
  upsert takes `excluded.created_at`. The passkey sign-in test signs a real
  P-256 assertion with `node:crypto`; a forged key and a reader calling the
  definer are refused. New cases cover bystander rows (other accounts' resets,
  2FA factor and passkeys survive), other accounts' former-email claims blocking
  a change, and a verify-time conflict. Successful password signup still needs
  the new account's writer (auth-handler batch). The release test therefore
  checks `allocateSignupIdentity` through `kody_admin` instead of a completed
  signup. Login in the 2FA journey still runs on the selected account's writer.
  Checks: 524 files across `app`, `identity`, `package-registry`, `email`,
  `account`, `aws`, `test-support`, `community`, `search-index`, `admin`,
  `feature-flags`, `platform-feedback`, `discord`, `oidc`, `security`,
  `site-banners` and `mcp`: 1,657 pass, 2 fail (the `frozen-keys` and
  `isolation` acceptance stubs). Worker typecheck, oxfmt and oxlint (0 warnings)
  pass on the touched files. Full node-unit and validate were not run (POC
  mode).

- **App batch 3: session, profile and verification resend (2026-10-01, POC
  mode):** six `app` test files drop their `d1-prepared-batch` regex emulators
  and run on PGlite with the session account's scoped writer:
  `authenticated-user`, `request-auth-cache`, `handlers/account`,
  `handlers/pending-verification`, `handlers/account-profile` and
  `handlers/account-resend-verification`. Entry check: worker typecheck passed;
  the six files were 26 / 0 on the emulators. The session/page reads were
  already PostgreSQL-compatible and passed on first run. New cases cover a
  cookie naming account 7 on another account's writer (resolves nobody, RLS),
  the RBAC-failure fallback via `REVOKE SELECT ON user_roles`, real role
  permissions from the seed, and round-trip counting through a wrapper on the
  real facade. Reds before the fixes: (1) a duplicate username returned 500. RLS
  hides the other account from the pre-read, and PostgreSQL omits the
  `Key (...)=(...)` detail for rows the caller cannot see. So
  `getUniqueConstraintField` returned `users_username_key`. It now derives the
  column from the default `<table>_<column>_key` name plus the reported table.
  That one shared fix also covers signup/admin creation and email-claim callers;
  `database-errors.node.test.ts` gained the scoped-writer case. (2) A successful
  verification send failed on
  `INSERT OR REPLACE INTO transactional_email_delivery_index`; it is now
  `ON CONFLICT … DO UPDATE` (new provider-message-id case, latest send wins).
  The profile test drops its `profile-service` mock and checks persisted rows on
  the real service, a bystander, and the old username retired to
  `username_redirects` through the curator definer. "Did not persist" uses a
  test trigger that keeps the old username. Resend checks live tokens, the
  bystander's token, `_rate_limits` slots and refunds on the real definers.
  Behavior change in the test only: with consistent data, a deleting account's
  session no longer authenticates (401). The writable-check 409 is covered by a
  purge claim landing after the session lookup, and the insert fence by one
  landing after the writable check. The pending-verification test settles the
  un-awaited flag prefetch (page auth, redirects never render) before closing
  PGlite. Checks: see the Phase log row; worker typecheck, oxfmt and oxlint (0
  warnings) pass on the touched files. Full node-unit and validate were not run
  (POC mode).

- **App batch 4: SSR and auth-page fixtures (2026-10-01, POC mode):** the 12
  `d1-prepared-batch` regex emulators (`ssr-render*` ×6, `public-signup-copy`,
  `auth-redirect`, `home`, `error-pages`, `auth-page`,
  `landing-testimonials-ssr`) run on PGlite. Anonymous pages use the pre-auth
  writer; signed-in pages use the session account's writer with seeded users,
  roles, flags and overrides (the home round-trip count wraps the real facade).
  All SQL was already compatible: 21 tests passed on first run.
  `test-support/d1-prepared-batch.ts` is deleted.
- **App batch 5: signed-out auth entry (2026-10-01, POC mode):**
  `0014_auth_entry.sql` adds `kody_account_email_owner` and
  `kody_oauth_connection_owner` (`kody_token_resolver`), `kody_signup_identity`
  and `kody_username_taken` (`kody_account_directory`). Login, password-reset
  request and provider sign-in resolve the owner and continue on
  `APP_DB_FOR_USER`; signup and provider signup write the account, role, email
  claim, verification token, connection and share invites on the new account's
  writer (`getNewAccountDb`). `allocateSignupIdentity` and
  `userExistsByUsername` call the definers on PostgreSQL. Converted:
  `auth-handler` (regex user emulator removed), `password-reset`
  (`#worker/db.ts` module mock and D1 stub removed; the grant race now triggers
  inside the first revoke pass), `auth-provider`, `auth-provider-reclaim-fence`
  (races wrap each account writer through `wrapAccountDb`), and
  `test-support/auth-provider-harness.ts` (PGlite, superuser `sql` fixture
  helper, `sessionUserId` for signed-in envs). A real red: the disconnect
  guard's SQLite `?1`/`?2` binds became `$11`/`$21` ("could not determine data
  type of parameter $1"); the facade now maps numbered binds (new `pg-database`
  case). New cases: persisted role/claim/token after signup, login stamping
  `last_active_at`, wrong password vs unknown address, definers returning only
  ids and refusing readers, reset request minting only for the owner, and a
  signup referral recorded through `kody_referral_referrer` (the referee cannot
  see the referrer). `two-factor` and `auth.audit-persist` login cases now use
  the pre-auth env (found by the full run).
- **App batch 6: deletion, retention, sweeps, admin (2026-10-01, POC mode):**
  `account-deletion` runs the full `deleteUserAccount` on PGlite through
  `kody_subject_purger` (bystander intact) and checks vector surfaces against
  the PostgreSQL catalog; its duplicate column-coverage case is removed (see
  Deleted tests). The row-map emulator stays for failure-injection orchestration
  (Stripe, OAuth, DOs, fence). Retention: `0015_retention.sql`
  (`kody_retention`) and `audit-migrations-pg/0002_audit_retention.sql`
  (`kody_audit_retention`); prunes delete by primary key (composite row values)
  instead of `rowid`; a new case proves both roles cannot read other columns or
  update. Two reds: a fixture violated the bundle source-identity unique index,
  and the coverage net found the squashed `archived_job_artifacts` (jobs-service
  owned, excluded like in `account/data-targets`). Usage campaigns:
  `0016_operator_sweeps.sql` lets `kody_admin` list candidates by
  `last_evaluated_at`; each candidate runs on its own writer via
  `getAccountEnv`. `admin-users` (300-line emulator) and `admin-roles` run on
  PGlite as `kody_admin`; the admin handler now passes `forUser` for
  verification and creation. `sentry-tunnel` uses the pre-auth writer. Root:
  `package-config-cleanup.ts` drops a package from secret approvals with
  `jsonb_array_elements_text` on PostgreSQL (new test, corrupt rows untouched,
  bystander intact).
- **Acceptance `frozen-keys` (2026-10-01):** its `postgres` home was the P3
  stub; `storeFrozenKey` now writes Durable Object names and vector ids verbatim
  as PostgreSQL row keys (the P2 probe table stands in, under the caller's RLS
  context). With the P4 KV/S3 rows already passing, the acceptance test is
  green: 1 / 10.
- **Closing classification:** remaining SQLite fixtures in `app` belong to P4/P5
  folders: `account-integrations-data`, `account-mcp-oauth-clients` (×2),
  `connect-oauth-chooser`, `admin-platform-integrations`,
  `admin-provider-marks`, `account-secret-providers` (P4
  `integrations`/`oauth-*`/secrets) and `account-webhooks`, `package-webhooks`
  (P5 `webhooks`). Single-query canned stubs (`account-billing-data`,
  `auth-denial-alerts`, …) and composition stubs (`admin-insights-data`,
  `fleet-package-error-rate-alerts`, whose queries are Analytics Engine or
  already PG-tested in `admin`) stay. `universal`/`client` have no D1-touching
  code left (only copy strings, P8 text sweep). Root D1 files: `db.ts` selects
  the PostgreSQL driver, `database-errors`/`audit-log` were converted earlier,
  and every `d1ContainsLikePattern` caller lowercases.

## P4 batch log

- **P3-independent adapter batch (2026-10-01):** started P4 while P3 is `[~]`
  (user choice: build what does not need Postgres, stop at the P3 boundary).
  Added `aws/dynamo.ts` (shared `send` and conditional-failure helper),
  `dynamo-kv.ts`, `s3-objects.ts`, `kms-envelope.ts`, `agentcore-identity.ts`,
  `dynamo-meters.ts` and `dynamo-runs.ts`, each with a command-shape test.
  `frozen-keys.ts` now stores the `dynamo` and `s3` homes through the adapters'
  key mappings; all 20 KV/R2 rows pass and the test fails at the first
  `postgres` row (`not implemented … (P3)`). Scoped run of `aws/` and
  `test-support/aws/`: 31 pass / 1 fail (frozen-keys). Worker typecheck, oxlint,
  oxfmt, knip and lockfile check pass. Full node-unit and validate not run (POC
  mode).
- **Stopped here: everything left needs P3.** All folder rows (`entitlements`,
  `usage`, `run-records`, `storage-buckets`, `integrations`, root `oauth-*`,
  secrets paths) run D1 SQL, and 14 of their tests still import
  `create-d1-from-sqlite`/`apply-all-migrations`. Replacing
  `test-support/memory-kv.ts` and `test-support/user-meter.ts` touches about 50
  D1-backed tests. Switching secrets to KMS rewrites `secret_entries` rows, and
  deleting the DO classes needs their callers switched. Resume once P3 is `[x]`;
  the `oauth-purge` DO still moves to P5.
- **Resume batch A: fake DynamoDB, UserMeter, KMS, KV (2026-10-01):** P3 is
  `[x]`. Scope split agreed with the user: RunLog's run history, logs,
  idempotency and triage are P4; its invocation ledger and workflow projections
  move with P5's workflows (the DO is deleted at the end of P5). Integration
  tokens and OAuth app secrets use KMS in Aurora now; the vault move happens
  with the egress proxy in P6.
  - `test-support/aws/fake-dynamo.ts`: in-memory DynamoDB that interprets the
    adapters' commands (conditions, update expressions, GSI queries, `Limit`
    paging, `TransactWriteItems`). Caller tests now run the production adapters.
    It caught a real bug: `dynamo-kv` reported `list_complete:false` on an exact
    last page (DynamoDB returns `LastEvaluatedKey` whenever `Limit` is hit); the
    adapter now probes one extra item.
  - UserMeter: `aws/dynamo-meters.ts` is a faithful `UserMeterRpc` over the
    `meters` table (counters `resource#day` with revision CAS and retries,
    storage bytes, deletion tombstone, write leases, delivery claims and lease
    acquire as transactions, MCP last-used, export, purge). Types moved to
    `entitlements/user-meter-client.ts`; the binding is `USER_METERS`
    (`forUser(userId)`), modelled in `EnvSchema`. `user-meter-do.ts`, its
    exports from `index.ts`/`platform-worker.ts` and
    `user-meter.workers.test.ts` are deleted; the DO suite became
    `user-meter.node.test.ts` (schema/upgrade/`blockConcurrencyWhile` cases
    dropped as DO mechanics). `test-support/user-meter.ts` now builds the
    adapter over the fake.
  - KMS: `mcp/secrets/crypto.ts` encrypts every purpose through `env.SECRET_KMS`
    (`KmsEnvelope` port) with context `{ purpose, userId }` (plus
    integration/app/endpoint names); `SECRET_STORE_KEY` is gone from `EnvSchema`
    and code. Tests use the shared `testSecretKms`.
  - KV: `test-support/memory-kv.ts` is `createDynamoKv` over the fake (same
    export, synchronous seeding).
  - `mcp/secrets` SQL: JSON containment uses `pg_input_is_valid` +
    `@> jsonb_build_array`; provider timestamps are bound values.
    `repo`/`lock-to-package` tests run on PGlite via the new
    `test-support/aws/user-test-env.ts`.
  - Scoped runs: 51 meter-related files 371 → all pass after stub rewrites; 38
    KMS files pass; 156 SQLite/PGlite files: only the `isolation` acceptance
    stub fails. Typecheck passes.
- **Batch B: storage-buckets and integrations (2026-10-01):** both rows ticked.
  - `test-support/aws/fake-s3.ts`: in-memory S3 for `aws/s3-objects.ts`;
    `createTestObjectBucket()` replaces the hand-written R2 stubs, so logo and
    provider-mark tests run the production R2-shaped adapter.
  - `0017_storage_sweeps.sql`: fleet sweeps (estimate backfill, repo-session
    inventory reconcile, storage-byte reconcile) list as `kody_admin` (inventory
    columns and owner ids only) and write each row on its owner's writer
    (`getAccountEnv`). The runtime `CREATE TABLE IF NOT EXISTS` in the cursor
    and repo due-owner modules is gone (both migration sets create the tables).
  - `0018_platform_integrations.sql`: platform OAuth apps are readable by the
    runtime roles and written only by `kody_admin`, which may also read and
    re-point `user_integrations.platform_app_slug` (rename), nothing else.
  - SQL: `IS ?` → `IS NOT DISTINCT FROM ?` (portable), required-host merge on
    `jsonb_array_elements_text`. All 13 integrations files and the
    storage-bucket service suite run on PGlite with per-user writers;
    `storage-buckets/service.workers.test.ts` folded into the node suite.
    `estimate-backfill.workers.test.ts` drives StorageRunner/RepoSession DOs and
    moves to P6; `integration-host-refresh-migration` stays a SQLite
    migration-file test like P3's `friendly-url-migration`.
  - Regression: 180 SQLite/PGlite/KMS files, 740 pass; only the `isolation` stub
    fails.
- **Batch C: run-records / RunLog run history (2026-10-01):** row ticked.
  - `aws/dynamo-runs.ts`: `createDynamoRunRecords` ports RunLog's run history
    onto the `runs` table (partition `userId`): `run#<id>` items indexed by the
    sparse `runs-by-started` GSI, log lines as one S3 object per run,
    `claim#<surface>#<key>` pointers for keyed claims (set atomically by
    `claimRun`, kept current best-effort by other keyed writes, released by
    abandon), triage incl. bulk triage as one ≤100-item transaction,
    stale-running heal on read and in the cap pass, 30-day TTL + 2,000-run cap
    every 32 finishes, export phases and `clearAll`. Job observability, package
    successes and activation milestones moved with it (`job#`, `pkg#`,
    `milestone#` items) because `finishRun` writes them in the same transaction
    as the run row. The generic idempotency helpers stay as
    `createDynamoIdempotency` for P5.
  - `run-records/run-log-types.ts`: row/triage types and pure helpers shared by
    the store, the service and the DO (moved out of `run-log-do.ts`).
  - `run-records/service.ts`: `runLogRpc` is a composite over `RUN_RECORDS` and
    the RunLog DO; ledger calls pass `run: null` to the DO and write the run row
    to the store. Export runs the store phases, then the DO's ledger and
    projection phases (`invocation-ledger:` handoff). Recording checks
    `RUN_RECORDS` (modelled in `EnvSchema`); account deletion purges both.
  - Tests: `run-records.node.test.ts`, `dedicated-state.node.test.ts` and
    `mcp/capabilities/runs/runs.node.test.ts` replace the Workers suites against
    the production store over the DynamoDB/S3 fakes
    (`test-support/ run-records.ts`); the package-invocation fake RunLog is
    ledger-only and reads runs from the store. The fakes caught one design gap:
    unclaimed keyed runs (workflow) must be indexed for surface-scoped lookups.
  - Also fixed P4 leftovers surfaced by the full suite: stale `USER_METER` /
    missing `SECRET_KMS` test envs (`export-paging`,
    `inbound-delivery- authority`, `jobs-service`) and the `user-meter`
    primitives path.

## P5 batch log

- **Completion: jobs, billing and durable Starts (2026-10-02).** JobsHost is
  removed. The existing jobs manager surface reconciles owner-prefixed Temporal
  Schedules against Aurora rows, including exact retry, fractional-second and
  lease-expiry wakes, manual Starts and owner-only purge. Each production
  Schedule is a one-shot wake; the existing jobs processor owns recurrence,
  claims, backoff and finalization. A selected job is claimed directly so a
  large account backlog cannot hide it behind the global due-job cap. An
  unexpected activity failure rearms through a separate retryable activity,
  preserving single-attempt execution and metering. Stripe refresh uses a
  SignalWithStart debounce workflow, an hourly retry and cancellation during
  account deletion. The DO implementation/export is removed. Durable Starts
  claim DynamoDB before Start, retain uncertain acknowledgments, use Temporal's
  duplicate rejection and fence each claim with a fresh run id. A workflow
  interceptor persists full terminal results encrypted in S3 before closing and
  completes the 90-day claim; dedupe survives missing history. Tests check
  uncertain responses, fresh clients and owner-bound decryption. Job repository
  and webhook HTTP behavior tests now use PGlite and owner RLS; billing/referral
  behavior tests moved from the Workers pool to node with the existing SQLite
  fixtures and DynamoDB meters (see deviation below).

- **Final verification (2026-10-02).** Consolidated P5 node run: **458 tests
  across 103 files passed** (156.67 s), including `webhook-delivery`, `job-run`
  and `publish-package`, real Temporal timer/retry/cancellation tests and
  owner-scoped run/account regression checks. A second package-workflow,
  billing-usage, DR and acceptance run passed **66 tests / 13 files** (32.83 s);
  these counts overlap and are not a unique total. The final unexpected-job
  failure/rearm test and job acceptance passed **3 tests / 2 files** (18.10 s).
  `CI=1 npm run validate` completed: **3,394 passed / 17 failed**, with nine
  deletion-fixture failures captured during an adapter change subsequently
  reverted; all nine pass in the final scoped run. The other eight failures are
  six P6/P7 acceptance stubs and the two known checkout prerequisites.
  Typecheck, lint (zero errors), Knip, primitives, documentation checks,
  Mermaid, slop ratchet and lockfile checks passed. The authoritative gate
  remains red on those later-phase/checkout tests, eight pre-existing formatting
  files (including the protected duplicate plan), missing migration history and
  six existing dependency audit findings. P5 completion is an incremental POC
  gate, not a full green or a production migration claim.

- **Run state and unvisited-run reconciliation (2026-10-02):** removed RunLog
  runtime and its SQLite billing capability. Invocation replay now runs on the
  production DynamoDB adapter over command-interpreting fakes: 90-day terminal
  TTL, durable bounded responses, hash-checked stale reclaims, and
  finish/release fencing. Run-history/S3 behavior and account export cursor
  phases are retained. Owner Temporal registry Updates serialize projection
  reservations; reads use Visibility and reconcile externally
  terminated/cancelled executions back to the registry. The standalone local
  Temporal test checks concurrent slots, owner rejection, stale/terminal
  retention, monotonic terminal state, paging, external termination,
  cancellation and purge (1 pass, 11.29 s). An hourly
  `run_records_reconciliation` ops Schedule visits non-deleting owners by
  PostgreSQL keyset and invokes existing owner-scoped run healing even for rows
  nobody reads. Its PGlite + production Dynamo adapter test passes. Regressions:
  run-records/invocation/capability registry 58 tests across 9 files; admin
  usage/account deletion/unverified purge/sweep 38 across 4; scheduled
  dispatch/export/remaining billing telemetry/bundled MCP 34 across 5 pass.
  Deliberate POC ceilings: invocation-id finish/release scans one owner's replay
  ledger; the ops sweep walks the fleet within one activity budget.

- **Batch A: Temporal core + target slice (2026-10-01).** `temporal/ids.ts`,
  `search-attributes.ts`, `codec.ts` (KMS envelope per payload, context
  `{ namespace, userId }` from the SDK serialization context; a payload moved to
  another owner's workflow fails), `client.ts` (namespace per queue: `app` and
  `platform` → core, `runtime` → exec, `ops` → ops), `worker.ts` (one worker per
  queue, one shared workflow bundle), `schedules.ts` (job Schedules) and
  `approvals.ts`. Workflows: `PackageInvocation`, `EventFanout`,
  `WebhookDelivery`, `JobRun`, `PublishPackage`, `HumanApproval`, `ExecuteRun`,
  written against one activity contract (`activities/types.ts`);
  `activities/target.ts` implements it over the `AwsEnv` fakes.
  `createTargetTestEnv()` starts a dev server and the four workers lazily on
  first `env.TEMPORAL` use. Spike: the time-skipping test server has no
  Schedules, so tests default to the Temporal CLI dev server (`createLocal`,
  cached after the first download, ~150 ms start) and keep time skipping as an
  option. Acceptance `webhook-delivery`, `job-run` and `publish-package` are
  green; `execute-run` waits for P6's run token. New tests: codec owner
  binding + encrypted history, Schedule conformance (Temporal's next fire equals
  `computeNextRunAt`). Worker typecheck, oxlint, oxfmt and the lockfile check
  pass; `@temporalio/{client,common,worker,workflow}` are worker dependencies.
- **Batch B: Queues → workflow Starts (2026-10-02).** Every Cloudflare Queue
  producer now starts a workflow and `queue-handler.ts` (plus the origin
  `queue()` export) is deleted. Package events (`events.dispatch`) start
  `EventFanout` (`{topic}:{eventId}`, event id = hash of emitter + idempotency
  key) whose production activities list the subscribers and deliver to one
  subscriber per child `PackageInvocation`; user-handler failures are final,
  pre-execution infrastructure codes throw and retry in place. Acknowledged
  webhook deliveries start `WebhookDelivery` (`{endpointId}:{deliveryId}`, the
  message rides as detail, the front door's rate limit already applied).
  Platform-feedback, community activity/listing-published, email delivery and
  Artifacts repo events keep their own dispatchers behind a generic
  `QueueMessage` workflow (`queue:{queue}:{key}`; 30 s × 3 retries as the
  consumer config; a failed run is the dead letter). `temporal/start.ts`
  (`startKodyWorkflow`, `startQueueMessage`) dedupes on workflow id;
  `activities/app.ts` is the production activity set; the app `Env` gains an
  optional `TEMPORAL` binding (absent → the old inline fallbacks). Consumers
  became per-message functions (`'ack' | 'retry'`) and their tests were
  rewritten to match; producer tests use
  `test-support/aws/recording-temporal.ts`. New
  `package-events/event-fanout.node.test.ts` runs the production fan-out on the
  time-skipping server (search attributes registered through the operator
  service). Scoped run: 78 files, only the `execute-run` stub (P6) fails.

- **Package durable timers (2026-10-02).** `PackageWorkflowRun` replaces the
  Cloudflare `WorkflowEntrypoint`: a durable Temporal timer waits until `runAt`,
  then sandbox execution, projection updates and usage recording run as separate
  activities. Create/cancel/list retain the existing entitlement and ownership
  checks through a Temporal engine facade; workflow ids are
  `{userId}:wf:{idempotencyKey}`, and Starts use the 90-day claim helper. Inline
  code keeps its package security context and invoke tools; exported package
  workflows keep the existing ephemeral invocation and 270-second sandbox
  budget. Activity databases and metering use `getAccountEnv` for the payload
  owner. Cloudflare workflow imports, the entrypoint export, and the workflow
  test stub are removed. Existing direct behavior checks use a test-only
  harness; actual orchestration runs on Temporal. Scoped verification: **38
  tests / 6 files passed**, including a standalone
  timer/retry/dedupe/cancel/suspension case on Temporal CLI Server 1.32.0 (36
  seconds). The old time-skipping server rejected cancellation plus
  idempotency-completion commands; the current local server passed. P6 still
  owns replacement of the sandbox executor with the Runner; P7 configures
  namespace-wide history retention.

- **Batch C: remaining catalog and ops cleanup (2026-10-02).** Added
  `AccountDelete`, `InboundEmail`, `OutboundEmail`, `McpServerConnection` and
  their Start/Signal clients. App activities delegate to the existing scoped
  domain services; mail bytes/drafts are loaded from S3 references inside an
  activity, and MCP activity results contain only connection status. The catalog
  checks prove owner binding, Start deduplication, inbound retries, no outbound
  replay after an uncertain provider response, and MCP entity backoff through
  Continue-As-New. OAuth sweeps now retain completed phase flags, a fixed expiry
  cutoff and totals across Continue-As-New. Ops Schedule upserts also delete any
  previously created CF backup/storage/DO billing schedules. Deleted the retired
  DR staging/export/restore/mailbox import routes and their now-unused
  implementations and tests. Retained `do-pitr` only for the remaining
  Mailbox/StorageRunner/repo-index backends until P6; the maintenance target
  list excludes RunLog, UserMeter and StripePlanRefresh. Catalog and ops scoped
  checks: 8 tests passed across three files; retained DR/slim-origin checks: 9
  passed across four files. These checks establish P5 orchestration only:
  mail/MCP still delegate to their legacy backends until P6, and P7 owns
  front-door/SES/capability entry wiring. Outbound and account deletion
  activities use one attempt while legacy provider calls lack a general
  retry-safe contract; an uncertain reply requires reconciliation.

## Decisions and deviations

**P3 Remix query adapter continuation (2026-09-30).** The next batch reuses the
installed Remix PostgreSQL driver rather than adding a SQL compiler. Its query
client delegates to the scoped facade; multi-query transactions use
`createDb(tx)` inside the facade transaction. The legacy SQLite driver remains
until its callers are converted. This changes no phase scope or package API.

| Date       | Phase | Decision                                                                                                           | Why                                                                                                                  |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | plan  | Rewrite tests in place; delete Cloudflare-only tests and packages                                                  | POC targets the new stack only                                                                                       |
| 2026-09-30 | plan  | In-process fakes (PGlite, Temporal time-skipping env, in-memory AWS fakes)                                         | No Docker needed; runs in the sandbox                                                                                |
| 2026-09-30 | plan  | Keep D1-shaped `prepare/bind` facade over Postgres                                                                 | Avoids touching the query call sites across ~2,600 source files in a POC                                             |
| 2026-09-30 | plan  | All new code in `packages/worker/src/*`, not separate packages                                                     | Fewest moving parts for the POC; split later                                                                         |
| 2026-09-30 | plan  | Data copy, cutover and decommission (target doc phases 4–6) out of scope                                           | POC proves the architecture, not the migration of live data                                                          |
| 2026-09-30 | P0    | Use `@electric-sql/pglite-pgvector` for `vector`; keep the normal node suite's two checkout failures as baseline   | PGlite publishes pgvector separately; this checkout lacks Git history and `.github/workflows/deploy.yml`             |
| 2026-09-30 | P0    | Skip persistent `core.hooksPath` configuration; use hook-free npm commands                                         | The actual `.git` belongs to the parent repository outside the writable project root                                 |
| 2026-09-30 | P0    | Run and retain `npm run validate` as the authoritative local gate                                                  | AGENTS.md explicitly overrides the plan's earlier instruction to avoid it; P0 found baseline gate failures           |
| 2026-09-30 | P1    | Move the jobs D1 initialization SQL into `packages/worker/migrations-jobs/`                                        | Existing account-purge tests still need the schema until P3 converts it to Postgres.                                 |
| 2026-09-30 | P1    | Call Shiki directly from the app and retain its token tests in `packages/worker/src/highlight/`                    | The separate highlight Worker and its service binding were removed.                                                  |
| 2026-09-30 | P1    | Remove retired Cloudflare primitives from the taxonomy map                                                         | The path checker must describe code that remains in the POC checkout.                                                |
| 2026-09-30 | P1    | Leave MCP and Playwright e2e harness rewiring for P7                                                               | Their Cloudflare mock imports are still unresolved after P1; P7 owns those transport tests.                          |
| 2026-09-30 | P2    | Start `migrations-pg` with a small forced-RLS fixture; add the full application schema in P3                       | P2 needs a real reader/writer isolation proof, while P3 owns the D1-to-Postgres schema conversion.                   |
| 2026-09-30 | P3    | Phase-specific checks replace validate as the migration exit criterion                                             | Explicit user instruction for this session; architecture changes are not proved by legacy aggregate tests.           |
| 2026-09-30 | P3    | Squash 71 app migrations plus retained job configuration into 96 tables; exclude jobs_worker_state                 | The current checkout has 71 application SQL files; alarm state belongs to retired Cloudflare scheduling.             |
| 2026-09-30 | P3    | Preserve integer flags and JSON/text timestamp contracts; normalize safe int8 results                              | Avoid changing application serialization while adopting PostgreSQL.                                                  |
| 2026-09-30 | P3    | Separate restricted admin and builtin indexer roles                                                                | Runtime writer privileges cannot bypass user RLS or mutate builtin vectors.                                          |
| 2026-09-30 | P3    | Current AGENTS.md restores validate as the authoritative local gate                                                | Current session instructions supersede the earlier session's gate deviation.                                         |
| 2026-10-01 | P3    | Add a read-only `kody_analytics` role for fleet-wide counters (user choice over extending `kody_admin`)            | Operator analytics needs cross-user totals; keep it separate from account administration and user content.           |
| 2026-10-01 | P3    | Move `platform-feedback-subscriptions.workers.test.ts` to P6                                                       | It executes package code in the sandbox and reads the RunLog ledger; PGlite alone cannot exercise it.                |
| 2026-10-01 | P3    | Leave `{} as D1Database` placeholders in mock-only `Env`-typed tests until P7                                      | They run no SQL; the global `Env` type still declares D1 until P7 introduces `AwsEnv`.                               |
| 2026-10-01 | P3    | Admin fleet insights use `kody_analytics` column grants; per-account reports use the subject's scoped reader       | Least privilege: counters and labels fleet-wide, full rows only within one account's RLS scope.                      |
| 2026-10-01 | P3    | POC mode: targeted suites replace full node-unit/validate for this batch                                           | Explicit user instruction ("this is poc, proceed accordingly") and AGENTS.md POC section.                            |
| 2026-10-01 | P3    | Account export/deletion use `kody_subject_reader`/`kody_subject_purger` (user choice over `kody_admin` or a split) | Owner RLS hides cross-user attribution; the subject roles keep deletion one atomic batch.                            |
| 2026-10-01 | P3    | Non-delete account targets run in a `SECURITY DEFINER` function                                                    | PostgreSQL checks an UPDATE's new row against SELECT policies, so RLS alone cannot anonymize.                        |
| 2026-10-01 | P3    | Export keysets use each table's primary key; R2 export cursor v4                                                   | PostgreSQL has no stable `rowid`; every application table has a primary key.                                         |
| 2026-10-01 | P3    | Embeddings use only the Bedrock port (Titan v2, 1,024-d); Workers AI/AI Gateway embedding path deleted             | pgvector stores 1,024-d vectors; a 384-d legacy path cannot share one index schema.                                  |
| 2026-10-01 | P3    | Rename the folder only; keep `*Vectorize*` export names; accessor prefers `SEARCH_INDEX` over the legacy binding   | Avoids churn across ~40 importers; the fallback goes when P7 introduces `AwsEnv`.                                    |
| 2026-10-01 | P3    | `kody_indexer` reads/writes builtin `vector_embed_fingerprints` rows only (`0009_search_index.sql`)                | Builtin reindex runs as the indexer; its skip cache was unreachable under RLS.                                       |
| 2026-10-01 | P4    | Start P4's P3-independent adapters before P3 is `[x]`; folder rows, fake swaps and DO deletions wait for P3        | User choice. The adapters touch no SQL; everything else rewrites D1-backed code that P3 is still converting.         |
| 2026-10-01 | P4    | Adapter tests inject `send` and assert `command.input` instead of adding `aws-sdk-client-mock`                     | Same command-shape check without the extra dependency (and sinon); matches `bedrock-embeddings.ts`.                  |
| 2026-10-01 | P4    | Pin `@aws-sdk/client-dynamodb`/`-s3`/`-kms` at 3.1137.0 (exact); add `client-bedrock-agentcore` to worker deps     | 3.1137.0 was the newest release more than 7 days old; agentcore is already in the tree at 3.1143.0.                  |
| 2026-10-01 | P4    | KV items are `pk = <KV key>`, `sk = 'value'`, with a `ns-pk` GSI for `list({ prefix })`; values capped at ~390 KB  | Frozen keys stay byte for byte; DynamoDB's 400 KB item limit needs an S3 spill if a caller ever needs more.          |
| 2026-10-01 | P4    | A missing meter item counts as zero (no `needs_bootstrap`)                                                         | Seeding from the D1 mirror is cutover work; the POC starts meters empty.                                             |
| 2026-10-01 | P3    | Public community reads use a read-only `kody_community` role (user choice over public RLS or `kody_admin`)         | Fourth documented exception; column grants keep email, credentials and rating notes out of public reads.             |
| 2026-10-01 | P3    | Owner actions on other users' community rows run in curator-owned `SECURITY DEFINER` functions                     | DELETE/UPDATE predicates must pass SELECT policies; owner policies would hide rows or expose rating notes.           |
| 2026-10-01 | P3    | Reporting finds active listings only (was: delisted too)                                                           | Reports read through the public role; a delisted listing is already moderated.                                       |
| 2026-10-01 | P3    | Defer `community-flow`, `community-icon` and `og-image` Workers suites to P6/P4–P7                                 | They exercise Artifacts, KV/R2/Images and workerd `ASSETS`, not SQL; none runs in the node pool today.               |
| 2026-10-01 | P3    | Share grants use grant-aware RLS plus `kody_account_directory` definers (user choice over a `kody_share` role)     | Consent-scoped access stays structural; no role sees every package or account row.                                   |
| 2026-10-01 | P3    | Grant rows are owner-created and column-limited for guests; scope grants become `kody_admin`-only                  | The `0002` owner-or-grantee ALL policies let a grantee forge grants; with share RLS that exposes any package.        |
| 2026-10-01 | P3    | Accepting a grant not addressed to the caller reports "no pending invitation" (was "not addressed")                | RLS hides the grant; the application can no longer tell the two cases apart.                                         |
| 2026-10-01 | P3    | Pre-auth token links resolve the owner via `kody_token_resolver` definers (user choice over a `kody_auth` role)    | Only the owner's stable id leaves the definer; no role can list outstanding token hashes.                            |
| 2026-10-01 | P3    | Request environments carry `APP_DB_FOR_USER` (owner writer factory); legacy `Env` falls back to `APP_DB`           | Signed-out flows (reset, verify, unsubscribe) learn the account mid-request; P7 builds it from `forUser`.            |
| 2026-10-01 | P3    | `_rate_limits` moves to PostgreSQL behind `kody_rate_limit_take/release` (user choice over a plain table or P4)    | Keys hold user ids and IPs; the advisory lock restores D1's atomic count-then-insert.                                |
| 2026-10-01 | P3    | Admin email verification: `users` via `kody_admin`, token rows via the target's writer (`forUser`)                 | Same split as account creation; the admin role never gains token-table access.                                       |
| 2026-10-01 | P3    | Email-change/release links and passkey sign-in resolve owners via `kody_token_resolver` definers (user choice)     | Same rule as `0012`: only the stable id leaves the definer; the passkey assertion is still verified.                 |
| 2026-10-01 | P3    | Email-in-use check is the boolean `kody_email_reserved_for_other` definer (user choice over `kody_admin`)          | Signed-in requests need no admin binding; the caller learns only true/false.                                         |
| 2026-10-01 | P3    | Passkey registration detects duplicates from the insert's unique violation instead of a pre-read                   | RLS hides other accounts' credentials; the constraint check is race-free on both dialects.                           |
| 2026-10-01 | P3    | `getUniqueConstraintField` maps default `<table>_<column>_key` constraint names to the column                      | Under RLS PostgreSQL omits the key detail; the constraint name and table still identify the field.                   |
| 2026-10-01 | P3    | Login, reset request and provider sign-in resolve the account through email/connection owner definers (`0014`)     | Same rule as `0012`/`0013`: only the stable id leaves the definer; the credential is verified on the owner's writer. |
| 2026-10-01 | P3    | Signup allocates through `kody_signup_identity` and writes on the new account's own writer                         | The pre-auth writer sees no accounts; RLS lets the new writer create and see only itself.                            |
| 2026-10-01 | P3    | Retention runs as `kody_retention` / `kody_audit_retention` and deletes by primary key                             | Fleet-wide pruning needs its own least-privilege roles; PostgreSQL has no `rowid`.                                   |
| 2026-10-01 | P3    | Fleet sweeps list as `kody_admin` and work per account through `APP_DB_FOR_USER` (`getAccountEnv`)                 | Matches the stall-alert lane; the operator sees only what the listing needs.                                         |
| 2026-10-01 | P3    | Keep the account-deletion row-map emulator for failure-injection orchestration tests                               | They test Stripe/OAuth/DO ordering, not SQL; the full deletion also runs on PGlite through the purger.               |
| 2026-10-01 | P3    | Move deletion of `create-d1-from-sqlite`, `apply-all-migrations`, `d1-retry` and the legacy D1 driver to P8        | Their remaining importers are in folders owned by P4–P6; the P3 box was conditional on no importers.                 |
| 2026-10-01 | P3    | Signup referral attribution finds the referrer through `kody_referral_referrer` (`0014`)                           | The referee's writer may record the referral row but cannot see the referrer; only a person's stable id leaves.      |
| 2026-10-01 | P4    | Split RunLog: run history, logs, idempotency and triage in P4; invocation ledger + workflow projections in P5      | User choice. The ledger and projections become `PackageInvocation` workflows and Temporal Visibility.                |
| 2026-10-01 | P4    | All Kody-held secrets (incl. integration tokens, app client secrets) use KMS in Aurora; vault move in P6           | User choice. The AgentCore Identity vault arrives with the egress proxy.                                             |
| 2026-10-01 | P4    | Test DynamoDB/S3 with in-memory command interpreters (`fake-dynamo`, `fake-s3`) running the production adapters    | Caller tests exercise real key shapes and conditions without DynamoDB Local/LocalStack; it already caught a KV bug.  |
| 2026-10-01 | P4    | The DynamoDB UserMeter keeps `needs_bootstrap` for missing counters (revises the P4 "missing counts as zero")      | Faithful `UserMeterRpc` port: callers keep seeding exactly as with the DO; no caller changes.                        |
| 2026-10-01 | P4    | Stale day rows read as absent and are overwritten conditionally; DynamoDB TTL only garbage-collects                | Matches the DO's seven-day prune without a delete on every call; TTL is lazy.                                        |
| 2026-10-01 | P4    | KMS encryption context is `{ purpose, ...owner }` (e.g. `{ purpose, userId, integration }`)                        | Keeps purpose separation (`v2` AAD) and the `{userId}` binding the target requires.                                  |
| 2026-10-01 | P4    | Fleet sweeps on storage (`0017`) and platform OAuth apps (`0018`) use column-limited `kody_admin` grants           | Same pattern as `0016`: list as the operator, write each row on its owner's writer.                                  |
| 2026-10-01 | P4    | `IS ?` becomes `IS NOT DISTINCT FROM ?`; quoted camelCase aliases (`AS "userId"`)                                  | PostgreSQL has no `IS <param>`; unquoted aliases fold to lower case. Both forms also run on SQLite.                  |
| 2026-10-01 | P4    | Keep the `entitlements`/`usage-snapshot` D1 emulators; `referral-program` stays on SQLite until P5 billing         | They test plan/limit logic and caching, not SQL; referral rewards stack both parties from the billing webhook.       |
| 2026-10-01 | P4    | Remove the Workers KV 5xx Sentry filter; refresh-family persist skips Sentry for DynamoDB throttling by error name | The SDK already retries throttling; structured names replace Workers binding message strings.                        |
| 2026-10-01 | P4    | Keep `kv-cachified.ts`; keep DO billing telemetry (`usage/durable-object-*`) until those DOs are gone              | The cache takes any `KVNamespace`; DO telemetry still measures RunLog/StorageRunner/etc. (billing re-base pending).  |
| 2026-10-01 | P4    | Defer `storage-buckets/estimate-backfill.workers.test.ts` to P6                                                    | It drives StorageRunner and RepoSession DOs end to end.                                                              |
| 2026-10-01 | P4    | Job observability, package successes and activation milestones move to `RUN_RECORDS` with run history              | `finishRun` writes them atomically with the run row; splitting stores would lose that transaction.                   |
| 2026-10-01 | P4    | Run logs live in S3 (one JSON object per run), not in DynamoDB items                                               | 200 lines × 16 KB can exceed DynamoDB's 400 KB item limit; matches the target doc's "S3 logs".                       |
| 2026-10-01 | P4    | Keyed lookups read a `claim#<surface>#<key>` owner pointer instead of scanning runs                                | O(1) and race-free for claims; other keyed writes update it (running first, then newest), as the DO's lookup did.    |
| 2026-10-01 | P4    | Run history ages out through DynamoDB TTL (readers hide expired items); the cap pass runs every 32 finishes        | No alarm in DynamoDB. Stale `running` rows heal on read and in the cap pass; unvisited ones wait for a P5 schedule.  |
| 2026-10-01 | P4    | Package-invocation ledger write and its run row are two writes (DO, then store)                                    | The ledger stays on the DO until P5's `PackageInvocation` workflow owns both (`ponytail:` note in `service.ts`).     |
| 2026-10-01 | P4    | Export order is run-store phases, then ledger and projections; cursor prefixes unchanged                           | One cursor across two stores; DO cursors past its own phases end the export instead of re-reading store phases.      |
| 2026-10-01 | P4    | `getSqlBillingStats`/`inspectRunLogSqlBilling` stay DO-only; their Workers tests are deleted                       | They measure DO SQLite row billing, which run history no longer touches; both go with the DO in P5.                  |

**P5 deviations and ceilings (2026-10-02).** Temporal CLI Server 1.32.0 is used
for Schedules and the package cancellation/interceptor check; the older
time-skipping server is retained only where it supports the tested APIs.
Production jobs use one-shot Schedules to preserve the existing processor's
retry and lease wake times. The 10-minute Schedule catch-up window is a POC
ceiling: longer outages require reconciliation before an exhausted one-shot
Schedule can resume. Namespace-wide 30-day history retention and Cloud
mTLS/API-key configuration remain P7; S3 result lifecycle belongs to infra.
Child workflows use the test namespace until cross-namespace Nexus wiring. Every
pool registers all activities until pools deploy separately.

Owner projection reservations serialize in one entity workflow (shard if one
account's throughput requires it). Ledger finish/release scans one owner's
records (add an invocation-id index at scale); job Schedule cleanup lists the
fleet (index Schedule owner attributes at scale). Stale-run reconciliation walks
the fleet within one 15-minute activity (page with Continue-As-New when that
budget is insufficient). These ceilings have `ponytail:` comments in code.
Outbound mail and account deletion use one attempt around legacy provider calls;
uncertain responses need reconciliation before replay.

The three billing behavior suites retain their existing SQLite fixtures while
moving to node and DynamoDB meters, revising the recipe's blanket fixture rule
for this batch. They prove plan, credit and referral behavior, not PostgreSQL
SQL conformance; convert those remaining fixtures in P8. Jobs and webhook HTTP
fixtures use the full PGlite schema and owner RLS. The still-used
`test-support/jobs-service*.ts` shim and `invoke-contract-cache.workers.test.ts`
remain for the P6 sandbox compatibility proof; substituting a fake bundler would
not prove unchanged published packages.

## Handoff notes

**P0 (2026-09-30).** Node v26.10.0 is on `PATH`; dependencies, mock env, and
worker typecheck are ready. PGlite with pgvector enforced cross-user RLS,
Temporal's local time-skipping workflow completed, and the AgentCore SDK export
is present. Node-unit baseline is 3,624 pass / 2 fail; both failures are
checkout prerequisites above. Workers-unit remains uncounted because local
`workerd` could not resolve its mock host. `npm run validate` ran and failed on
missing Git history, existing formatting issues, six audit advisories, and
platform/runtime startup CPU budgets. P0 proves test-library feasibility only;
P6 still must prove real published packages run unchanged in the Runner.

**P1 (2026-09-30).** The 102 Workers tests are inventoried; four Cloudflare-only
mechanics suites and the Workers pool are removed. The sibling Workers,
Cloudflare deploy/DR tooling, and mock server are pruned; Shiki now runs
in-process, and the jobs SQL is retained for P3. The node gate is 3,282 pass / 2
baseline fail / 0 skip; worker typecheck, lint, Knip, and primitives pass.
`npm run validate` still fails on the two checkout test prerequisites, missing
migration Git base, existing formatting debt, and six audit advisories. MCP and
Playwright e2e harnesses wait for the P7 front-door rewrite.

**P2 (2026-09-30).** PGlite reader/writer roles, per-user RLS, AWS-shaped fakes,
and a time-skipping Temporal test environment are in place. Ten fake tests pass;
all ten target acceptance tests fail at explicit `not implemented` stubs. The
full node suite is 3,292 pass / 12 fail: ten intended red cases plus the two P1
checkout failures. `npm run validate` ran; typecheck, lint, Knip, primitives,
and docs checks pass, while the intentional reds and existing format, audit, and
migration-history failures remain. P3 supplies the application SQL schema.

**P3 foundation (2026-09-30, in progress).** P2 exit gate was rechecked: ten
fake tests green, ten intended stub failures, full suite 3,292 pass / 12 fail.
The PostgreSQL baseline, RLS, pool/PGlite facade, pgvector/full-text and Bedrock
ports are implemented; the first identity/root batch passes. Full regression:
3,299 pass / 12 unchanged expected failures. A later cascade case passes in the
scoped database checks. Continue with remaining folder rewrites, production
request/activity environments and legacy-helper removal. Phase checks are the
migration gate per the user's instruction; validate was not run.

**P3 continuation (2026-09-30, in progress).** Added separate Postgres audit
storage with append-only and read-only roles, banner persistence with dismissal
isolation, feature flag persistence and exposure counters. Four SQL emulators
were removed across service, HTTP and MCP flag journeys. The Postgres acceptance
case is green. Full regression found one obsolete fixture; its replacement and
matching MCP journey pass. Remaining work includes feature metric readout,
application/authentication and other folder batches, Vectorize caller
conversion, request/activity environment construction, audit-reader consumer
wiring and legacy-helper removal. No validate run or deployment was performed.

**P3 identity activation/background (2026-09-30, in progress).** Activation SQL
runs on PostgreSQL with UTC calendar-day comparisons. The former handwritten
activation/funnel fixtures and background Workers suite use PGlite and scoped
roles. Background execution now rejects unverified accounts at the shared
chokepoint. Final caller regression: 193 tests across 54 files pass; typecheck
passes. Validate ran: 3,306 node tests pass with the same 12 established
failures; existing formatting, audit and migration-history blockers remain.
Continue with RBAC mutations, account creation, and the remaining P3 folder/SQL
conversions; P3 is not complete.

**P3 RBAC/account creation (2026-09-30, in progress).** Administrative creation
and role mutations use PostgreSQL SQL; former-email and app-permission journeys
use PGlite. Ordinary writers cannot self-promote; setup tokens stay scoped to
the created user. Continue with signup/provider account creation and production
request/activity database construction, including authorized admin selection and
the new-user writer callback. Other P3 folder conversions remain open.

**P3 shared Remix queries (2026-09-30, in progress).** Migrated bindings use the
installed PostgreSQL compiler through the scoped facade. Four account/auth SQL
fixtures use PGlite; pagination and owner/reader boundaries are checked. Scoped
regression: 69 tests pass; full validation: 3,305 pass / 12 unchanged failures.
Continue with production authentication/account-setup database construction,
provider signup and remaining folder conversions. P3 remains incomplete.

**P3 feedback/Discord/OIDC/readout (2026-10-01, in progress).** Platform
feedback, feature flags and the banners/security/Discord/OIDC row are ticked.
Submitters write through scoped writers; review uses `kody_admin`; the new
read-only `kody_analytics` role serves fleet counters for the flag readout. Full
node-unit: 3,305 pass / 12 unchanged failures. Next: the `admin` folder (extend
`kody_analytics` grants for usage insights), `account`, `vectorize`, then
`community`/`package-registry` and the remaining `app` fixtures.

**P3 admin (2026-10-01, in progress).** `admin` row ticked: fleet insights on
`kody_analytics` (`0007_admin_insights.sql`), mailbox owner listing on
`kody_admin`, per-account reports on the subject's reader. Fixed one real
dialect bug (unquoted camelCase alias). Similar unquoted camelCase aliases
remain in `storage-buckets/service.ts`, `shared/src/jobs/repo.ts`,
`shared/src/jobs/archived-artifacts-repo.ts` and `dr/exporter-inventory.ts`;
quote them when those folders convert. Fleet sweeps still pass the operator
`env` to per-user entitlement reads, which RLS would scope to the operator;
production wiring (P7) must supply per-subject readers. Still SQLite-dialect:
`users-data.ts` (`LIKE`, `COLLATE NOCASE`), `credit-grants.ts`, and the
entitlements storage recompute (`CAST AS BLOB`); their tests live in `app`,
`mcp` and `entitlements`. Next: `account`, `vectorize`, `community`,
`package-registry`, remaining `app`.

**P3 account (2026-10-01, in progress).** `account` row ticked. Export reads
through `kody_subject_reader`; deletion runs through `kody_subject_purger` plus
the `kody_subject_anonymize()` definer (`0008_account_subject.sql`, generated
from the inventory; regenerate it when `accountUserDataTargets` changes, and
`data-targets.node.test.ts` fails if it drifts). Export pages by primary key.
The purge's `subjectEnv`, the admin capability and the scheduled lane still pass
the legacy env; P7 must construct the per-subject purger. The row-map deletion
emulator in `test-support/account-deletion.ts` remains for `app`. Next:
`vectorize` → `search-index`, `community`, `package-registry`, remaining `app`
(including `app/account-deletion` on PGlite).

**P3 search index (2026-10-01, in progress).** `search-index` row ticked.
Embeddings go through `BEDROCK_EMBEDDINGS` only; the index accessor returns the
pgvector `SearchIndex` type and prefers `SEARCH_INDEX`. Builtin fingerprints
need the `kody_indexer` database (`0009`); P7 must build the builtin reindex env
with that role and a builtin `SEARCH_INDEX`, and per-user envs with the user's
index. `data-storage.md` still describes Workers AI/Vectorize fingerprint skips
(P8 text sweep). Next: `community`, `package-registry`, remaining `app`
(including `app/account-deletion` on PGlite), `universal`/`client`, then caller
conversion off `CAPABILITY_VECTOR_INDEX`.

**P3 community (2026-10-01, in progress).** `community` row ticked. Public reads
go through `getCommunityDb(env)` (`kody_community`, `0010`); P7 must bind
`COMMUNITY_DB` in every request/activity environment (anonymous ones included)
and build admin environments whose `APP_DB` is `kody_admin` for moderation
capabilities. App callers in `app/` (`community-data.ts`, `package-page.ts`,
`community-package-route.ts`, …) still pass `env.APP_DB` straight to repo/URL
helpers; switch them to `getCommunityDb` in the `app` row, keeping the owner db
for own-private package pages. `findPublicUserIdentityByUsername` and
`findPersonUserByEmail` select email and are used cross-user by webhooks,
package invocations, inbound email and share grants. Next: `package-registry`
(share grants are a cross-user surface that needs its own authorization
decision), then remaining `app`.

**P3 package-registry (2026-10-01, in progress).** `package-registry` row
ticked. Share grants are grant-aware RLS plus `kody_account_directory` definers
(`0011`); scope grants are admin-only. P7 must give admin scope-grant
capabilities a `kody_admin` `APP_DB`. Still reading other users' rows through
the caller's writer (left for their rows):
`package-runtime/package-import- resolution.ts` (platform-scoped imports read
the platform's saved package — `app`/P6), `findPublicUserIdentityByUsername` in
webhooks, package invocations and inbound email, and `app/` community callers.
`service.node.test.ts`'s entitlement emulator waits for P4 `entitlements`. Next:
remaining `app`, then `universal`/`client` and root D1 files.

**P3 identity tail + app batch 1 (2026-10-01, in progress).** `identity` row
ticked; 41 `app` test files still use SQLite fixtures (down from 50). Signed-out
flows find their account through `0012` definers. They then run on
`APP_DB_FOR_USER(stableUserId)`. P7 must bind that factory, plus a pre-auth
`APP_DB` writer with no user context, in every request environment. Without it,
the PostgreSQL path throws. Admin verify/mint callers (`admin-users.ts`,
`admin-user-verify.ts`) and the stall-alert scheduled lane still pass the legacy
env; P7 gives them a `kody_admin` `APP_DB` and `forUser`. Signup, login and
password-reset _request_ still find accounts by email before sign-in; they need
the same treatment (an email → owner definer) in the auth-handler batch. Next
`app` batches: signed-in account handlers (`account-*`, `two-factor`,
`passkeys`, `session-*`), the `d1-prepared-batch` SSR/auth fixtures, then
`account-deletion`/`retention`. After `app`: `universal`/`client` and the root
D1 files.

**P3 app batch 2 (2026-10-01, in progress).** 2FA, passkeys, password change,
email change, former-email release and `/session` run on PGlite. `0013` adds the
email-change, release and passkey owner definers and the email-in-use definer.
P7 must bind `APP_DB_FOR_USER` for `/verify-email-change`,
`/verify-email-claim-release`, `/webauthn/authentication` and `/verify/2fa`, and
give every signed-in request the session account's writer. Still open in the
auth-handler batch: login, signup and password-reset _request_ find accounts by
email (an email → owner definer), and successful password and provider signup
need the new account's writer. Next `app` batches: `account-profile`,
`account-resend-verification`, `account`, `authenticated-user`,
`request-auth-cache`, `pending-verification`, the SSR fixtures, then
`account-deletion`/`retention`.

**P3 app batch 3 (2026-10-01, in progress).** Session resolution, the account
and pending-verification pages, profile settings and the verification resend run
on PGlite; 30 `app` test files still use SQLite fixtures or emulators.
`getUniqueConstraintField` now reads default `<table>_<column>_key` names, since
RLS hides PostgreSQL's key detail. That matters for every caller that maps a
unique violation to "taken". The delivery index upsert is portable. P7 must give
every signed-in request the session account's writer as `APP_DB`. Next `app`
batches: the 12 `d1-prepared-batch` SSR/auth-page fixtures (`ssr-render*`,
`home`, `error-pages`, `auth-page`, `auth-redirect`, `public-signup-copy`,
`landing-testimonials-ssr`), then delete `test-support/d1-prepared-batch.ts`.
After that: the auth-handler batch (email → owner definer for login, signup and
reset request), then `account-deletion`/`retention`. `connect-oauth-chooser`,
`account-integrations-data` and the `account-mcp-*`/webhooks/secret-provider
handlers wait for P4.

**P3 done (2026-10-01).** Every P3 folder row is ticked; all application SQL in
P3-owned code runs on PostgreSQL with RLS and least-privilege roles. Signed-out
entry (login, signup, reset request, provider sign-in) reaches accounts only
through owner definers (`0014`) and continues on the owner's or the new
account's writer. Retention and fleet sweeps have their own roles (`0015`,
`0016`, audit `0002`). Full node-unit: 3,339 pass / 11 fail (nine acceptance
stubs for P5–P7, two checkout prerequisites); the PostgreSQL isolation case and
`frozen-keys` are green; worker typecheck, oxlint (0 errors), oxfmt, Knip,
primitives and the docs temporal check pass. Open for later phases: P4 converts
the integrations/OAuth/secret-provider fixtures in `app` and the remaining
SQLite-isms in `entitlements`/`integrations`/`mcp/secrets`; P5 the webhook
fixtures; P7 builds request/activity environments (`APP_DB_FOR_USER`, pre-auth
writer, `kody_admin`/`kody_retention`/`kody_subject_*` databases) and `AwsEnv`;
P8 deletes the remaining D1 helpers. Details:
[P3 relational store](../docs/migration/p3-relational-store.md).

**P4 done (2026-10-01).** Every P4 row is ticked: UserMeter, OAuth/bundle KV, R2
objects, secrets (KMS) and now RunLog run history run on the DynamoDB/S3/KMS
adapters, exercised in node tests through the production adapters over in-memory
fakes. `RUN_RECORDS` owns run history, logs (S3), keyed claims, triage and the
job/activation counters; `runLogRpc` routes only the invocation ledger and
workflow projections to the RunLog DO. Full node-unit: 3,375 pass / 11 fail
(nine acceptance stubs for P5–P7, two checkout prerequisites); `frozen-keys` and
the PostgreSQL isolation case are green; worker typecheck, oxlint (0 errors),
oxfmt on changed files, Knip and primitives pass. For P5: replace the DO ledger
and projections with `PackageInvocation` workflows and Visibility (then delete
`run-log-do.ts`, `run-log-meta-test-seed.ts`, and the
`invocation-ledger`/`dedicated-state` Workers remnants; the projection retention
case there must be retriggered through a ledger finish); start workflows through
`createDynamoIdempotency`; add a schedule that heals stale `running` rows nobody
reads. P6 owns `sandbox-logs.workers.test.ts`; P7 builds `RUN_RECORDS` (and
`USER_METERS`, `SECRET_KMS`) from `AwsEnv`; P8 updates
`docs/contributing/architecture/run-records.md` and `data-storage.md`, which
still describe the DO.

**P5 done (2026-10-02).** Durable paths now have Temporal workflows,
owner-scoped activities, Schedules and 90-day DynamoDB/S3 Start dedupe; RunLog,
JobsHost, StripePlanRefresh DO, the queue handler and WorkflowEntrypoint are
removed. P5 acceptance and final scoped regressions pass; the full gate's
remaining limits are recorded in the P5 batch log. Next: P6 must replace the
sandbox/mail/MCP backends and prove real `workerd` package compatibility; P7
must wire AWS owner/operator environments, entry transports and namespace
retention. P8 owns remaining test shims, stale architecture text and full green.
