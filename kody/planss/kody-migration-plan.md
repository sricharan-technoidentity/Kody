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
- Run `npm run validate` as the repository's authoritative local gate after
  phase work. It includes local Wrangler dry-run checks. Never run
  `npm run deploy*`, standalone `wrangler` commands, `cdk deploy`, or anything
  that talks to real AWS, Cloudflare or Temporal Cloud.
- **Mock credentials only** (section 3). If code needs a secret that is not in
  section 3, add a fake value there and use it.
- **Network** is allowed for npm dependency install, the one-time Temporal
  test-server download, and `npm run validate`'s audit check.
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
| P1  | Prune Cloudflare-only surface                                                | [ ]    | tooling + sibling packages       |
| P2  | Target test harness + acceptance suite (red)                                 | [ ]    | 10 new files                     |
| P3  | Relational store: D1 → Aurora PostgreSQL (PGlite in tests)                   | [ ]    | ~200                             |
| P4  | Key-value, objects, keys: DynamoDB, S3, KMS, AgentCore Identity              | [ ]    | ~55                              |
| P5  | Orchestration: Temporal workflows replace DO alarms, Workflows, Queues, Cron | [ ]    | ~40                              |
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
# authoritative local gate (local Wrangler dry runs; may expose baseline failures)
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

- [ ] Build `docs/migration/workers-tests-inventory.md`: one row per
      `*.workers.test.ts` (102 files) with the recipe rule (section 5) and
      owning phase. Rule-1 files are deleted now; the rest are rewritten in
      their phase.
- [ ] Delete rule-1 workers tests and log them.
- [ ] Remove `./vitest.workers.config.ts` from the projects in
      `vitest.config.ts`, then delete the file. Delete the
      `tools/vitest-global-setup-*` files that only serve it (keep
      `worker-bundler-modules` and `guide-catalog-modules` if node-unit still
      uses them).

Delete packages. First run `grep -r "<package-name>" packages/worker`, and move
any imported pure helper into `packages/worker/src` before deleting:

- [ ] `packages/platform-worker`, `packages/runtime-worker`
- [ ] `packages/jobs-worker` (becomes Temporal Schedules in P5; note the
      `jobs-worker/migrations` tables for the P3 schema)
- [ ] `packages/highlight-worker`. First move the Shiki highlight function into
      `packages/worker/src/highlight/` with its 2 tests
- [ ] `packages/status`, `packages/nx-cache`, `packages/backup-control-plane`
- [ ] `packages/mock-servers/cloudflare`,
      `packages/worker/src/test-support/cloudflare-mock-server*.ts`

Delete Cloudflare tooling in `tools/` (and their tests):

- [ ] `wrangler-*`, `deploy.ts`, `check-deploy-guardrails*`,
      `check-worker-startup-*`, `worker-startup-*.json|md`,
      `worker-additional-module-allowlist*`, `origin-worker-config*`,
      `local-d1-persist*`, `export-d1-remote-to-sqlite.sh`,
      `vite-worker-whole-graph-reload*`,
      `wrangler-filter-kody-generated-watch*`, `tools/ci/*-resources.ts`,
      `tools/disaster-recovery/*d1*`
- [ ] Anything else in `tools/` whose only purpose is Cloudflare deploy/DR
      (decide per file; log each)

`package.json`:

- [ ] Remove `prepare` (husky), `lint-staged`, and scripts for deleted things
      (`*:build`, `*:deploy`, `backup:*`, `status:*`, `nx-cache:*`,
      `worker-startup-*`, `deploy-guardrails:check`, `test:workers`).
- [ ] Keep `npm run validate` as the authoritative gate; update it to remove
      checks for deleted Cloudflare packages and include POC typecheck and
      `test:node`.
- [ ] Do **not** remove `wrangler` / `@cloudflare/*` deps yet; runtime code
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

- [ ] `test-db.ts` — `createTestDb({ userId? })`: PGlite + vector, applies
      `migrations-pg/*.sql`, returns `{ db, reader, pg }`. `db` is a **D1-shaped
      facade** (`prepare().bind().all/first/run/raw`, `batch()` in one
      transaction, `?` → `$n`) so existing call sites keep working. `reader`
      throws on any write statement. Tip: build a template once per worker with
      `dumpDataDir()` and clone it per test for speed.
- [ ] `fake-kv-table.ts` — DynamoDB-shaped item store: get/put/delete,
      conditional update, query by partition + sort prefix, TTL. When
      constructed with a session `userId`, it rejects items whose partition key
      does not start with it (mirrors `dynamodb:LeadingKeys`).
- [ ] `fake-object-store.ts` — S3-shaped get/put/list/delete by key; optional
      prefix guard per user.
- [ ] `fake-kms.ts` — envelope encrypt/decrypt with AES-GCM; decrypt fails if
      encryption context differs.
- [ ] `fake-token-vault.ts` — AgentCore Identity: store/fetch OAuth tokens per
      `(userId, provider)`; only allowed workload names may fetch.
- [ ] `fake-runner.ts` — AgentCore Runtime client: records
      `{ runtimeSessionId, payload }`, scripted responses, optional `node:vm`
      executor for simple code (`// ponytail: not a security boundary`).
- [ ] `fake-code-interpreter.ts` — file map + scripted results for `bundle`,
      `typecheck`, `lint`.
- [ ] `fake-ses.ts` — outbox array + inbound event helper.
- [ ] `temporal-env.ts` — wraps `TestWorkflowEnvironment`;
      `startWorker({ taskQueue, activities })` using a cached
      `bundleWorkflowCode` result.
- [ ] `target-test-env.ts` — `createTargetTestEnv()` wires all of the above into
      one `env` object matching the new `AwsEnv` type, with section-3 values.
- [ ] One node test per fake that checks its guard (cross-user key rejected,
      wrong KMS context fails, reader refuses writes).

Stubs so the red suite typechecks: create each new module in section 2's layout.
Each one exports its functions/workflows, and each export throws
`new Error('not implemented: <name>')`.

Acceptance tests (one file each, long journey tests, all red at the end of P2):

- [ ] `temporal/execute-run.node.test.ts`. `execute` → Update-with-Start
      `ExecuteRun` (id `{userId}:execute:{requestId}`) → meter consumed (fails
      closed when spent) → run token minted → Runner invoked with a per-user
      `runtimeSessionId` → result capped at 100 KB → run record written. The
      same `requestId` sent twice runs once.
- [ ] `temporal/webhook-delivery.node.test.ts`. Valid HMAC → `WebhookDelivery`
      `{endpointId}:{deliveryId}` → `ack` returns 202 after Start, `sync`
      returns the result. A duplicate delivery attaches to the same workflow. A
      bad HMAC or a replay starts nothing. The rate limit returns 429.
- [ ] `temporal/job-run.node.test.ts`. Schedule `job:{userId}:{jobId}` fires
      `JobRun` → `job_runs_per_day` consumed → a failure emits
      `run.error.recorded` into `EventFanout` → the subscriber's
      `PackageInvocation` runs.
- [ ] `temporal/publish-package.node.test.ts`. Checks run in the code
      interpreter → a locked package waits on the `HumanApproval` signal (an
      agent cannot send it) → bundle stored in S3 by commit → reindex →
      `published_commit` advances last.
- [ ] `broker/capability-broker.node.test.ts`. The run token is verified on
      every call. Expired or tampered tokens are refused. The storage bucket
      comes from the token's provenance, not from the request.
- [ ] `egress/egress-proxy.node.test.ts`. Placeholders are resolved only here.
      Retriever tokens are refused. Hosts are checked against the allowlist and
      `required_hosts`. Kody hostnames, private ranges and the metadata IP are
      blocked. `outbound_fetches_per_day` fails closed.
- [ ] `storage-cell/storage-cell.node.test.ts`. The `sql()` API is unchanged.
      The lease uses a fencing token, so a stale owner's write is rejected.
      `storage_bytes` is reserved before each write. The 1,000-row cap holds.
- [ ] `front-door/read-write-split.node.test.ts`. A GET page renders from
      `reader` only. A form POST becomes a Temporal Update and never touches the
      writer directly. The read-after-write flag routes the next read to the
      writer.
- [ ] `security/isolation.node.test.ts`. User A cannot read user B's data
      through Postgres RLS, the KV fake, the object store or a KMS context. A
      suspended or unverified user is refused at the front door, broker and
      egress proxy.
- [ ] `aws/frozen-keys.node.test.ts`. A table maps every frozen key format in
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

- [ ] Apply all 72 SQLite migrations to a scratch SQLite DB, dump the final
      schema, and translate it to
      `packages/worker/migrations-pg/0001_baseline.sql`. Use a one-off script in
      `tools/pg/` and delete it afterwards. Include the `JOBS_DB` tables that
      survive (job config rows). Squashing is a POC choice: log it.
- [ ] Add `0002_rls.sql`: roles `kody_writer` and `kody_reader`. `ENABLE` and
      `FORCE ROW LEVEL SECURITY` on every table with `user_id`, with the policy
      `user_id = current_setting('app.user_id')`. The four documented cross-user
      exceptions get a separate admin role.
- [ ] Add `0003_vectors.sql`: pgvector tables replacing Vectorize namespaces
      (`user_id` column; built-ins under `__kody_builtin__`), plus a full-text
      index.

Tests first (rules 2–3 in section 5), then code, per directory. For folders over
30 files, work in batches of ≤15 and log each batch.

| Folder                                                                        | CF-coupled / total | Done |
| ----------------------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/app`                                                              | 114 / 176          | [ ]  |
| `worker/src/community`                                                        | 19 / 31            | [ ]  |
| `worker/src/package-registry`                                                 | 14 / 21            | [ ]  |
| `worker/src/identity`                                                         | 10 / 18            | [ ]  |
| `worker/src/admin`                                                            | 7 / 8              | [ ]  |
| `worker/src/account`                                                          | 6 / 7              | [ ]  |
| `worker/src/vectorize` → rename `search-index`                                | 6 / 7              | [ ]  |
| `worker/src/platform-feedback`                                                | 5 / 5              | [ ]  |
| `worker/src/feature-flags`                                                    | 3 / 3              | [ ]  |
| `worker/src/status-incidents`, `site-banners`, `security`, `discord`, `oidc`  | 7 / 12             | [ ]  |
| `worker/universal`, `worker/client` (D1-touching only)                        | 6 / 196            | [ ]  |
| `worker/src/(root)` D1 files: `db.ts`, `d1-*`, `database-errors`, `audit-log` | subset of 30 / 55  | [ ]  |

Code:

- [ ] `aws/pg-database.ts` — the same D1-shaped facade, over a `pg` Pool in
      production and PGlite in tests. Keep the binding name `env.APP_DB` for the
      POC (`// ponytail: D1-shaped facade, replace with typed queries later`).
      Add `env.APP_DB_READER`.
- [ ] Every request/activity sets `app.user_id` in its transaction.
- [ ] Translate SQLite-isms in source (file counts at plan time):
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
- [ ] Vector search: replace Vectorize calls with pgvector queries. Embeddings
      go through a Bedrock client port; the fake returns deterministic vectors
      from a text hash.
- [ ] Delete `test-support/create-d1-from-sqlite.ts`, `d1-prepared-batch.ts`,
      `apply-all-migrations.ts`, `d1-retry.ts` (and tests) once no importer
      remains.

**Gate:** all folders in the table ticked; node-unit has no new failures; the
Postgres part of acceptance `security/isolation` is green.

---

## P4 — Key-value, objects, keys: DynamoDB, S3, KMS, AgentCore Identity

**Goal:** no KV, R2 or per-user-state Durable Object remains. **Entry check:**
P3 `[x]`.

| Folder / files                                                 | CF-coupled / total | Done |
| -------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/entitlements` (UserMeter)                          | 7 / 10             | [ ]  |
| `worker/src/usage`                                             | 15 / 26            | [ ]  |
| `worker/src/run-records` (RunLog)                              | 6 / 7              | [ ]  |
| `worker/src/storage-buckets`                                   | 4 / 4              | [ ]  |
| `worker/src/integrations`                                      | 8 / 13             | [ ]  |
| root `oauth-*` files (grants, refresh family, purge, handlers) | ~12                | [ ]  |
| secrets code paths (grep `SECRET_STORE_KEY`)                   | —                  | [ ]  |

Code:

- [ ] `aws/dynamo-meters.ts` — `meters` table, key `userId` / `counter#day`,
      conditional atomic updates; replaces `entitlements/user-meter-do.ts` and
      `user-meter-client.ts`. Replace `test-support/user-meter.ts` with the
      fake.
- [ ] `aws/dynamo-kv.ts` — a `KVNamespace`-shaped adapter (get/put/delete/list
      with cursor) over the `oauth` table. `@cloudflare/workers-oauth-provider`
      storage then keeps working with identical key strings. Replace
      `test-support/memory-kv.ts`.
- [ ] `aws/s3-objects.ts` — R2-shaped get/put/list/delete over S3 with the same
      keys (bundles, MIME, assets, logs).
- [ ] `aws/dynamo-runs.ts` — `runs` (90-day TTL) and `idempotency`
      (`userId#surface#key`) tables; replaces `run-records/run-log-do.ts`.
- [ ] `aws/kms-envelope.ts` — encrypt/decrypt with context `{ userId }`,
      replacing AAD `user:<userId>`.
- [ ] `aws/agentcore-identity.ts` — token vault client; only egress proxy and
      MCP-client activities may fetch.
- [ ] One adapter test per production adapter using `aws-sdk-client-mock` to
      check command shapes (keys, condition expressions, encryption context).
- [ ] Delete the replaced DO classes, `cloudflare-kv-platform-error.ts`, and the
      `oauth-purge` DO (it becomes a P5 ops lane). Delete `kv-cachified.ts` too,
      or re-point it at the new KV.

**Gate:** folders ticked; the KV/R2 rows of `aws/frozen-keys` are green;
node-unit has no new failures.

---

## P5 — Orchestration: Temporal

**Goal:** every durable or scheduled path is a Temporal workflow; every write
from the front door is a Start, Signal or Update. **Entry check:** P4 `[x]`;
Temporal test env works (P0 spike B).

| Folder / files                                                                           | CF-coupled / total | Done |
| ---------------------------------------------------------------------------------------- | ------------------ | ---- |
| `worker/src/jobs`                                                                        | 9 / 15             | [ ]  |
| `worker/src/package-invocations`                                                         | 8 / 16             | [ ]  |
| `worker/src/webhooks`                                                                    | 7 / 12             | [ ]  |
| `worker/src/package-events`, `worker/src/scheduled`                                      | 1 / 2              | [ ]  |
| `worker/src/billing` (StripePlanRefresh DO)                                              | 4 / 8              | [ ]  |
| `worker/src/dr` (keep only logic that becomes an `ops` lane; delete D1 backup specifics) | 6 / 9              | [ ]  |
| root `queue-handler`, `deferred-work`, `*-maintenance`, `maintenance-handler`            | subset             | [ ]  |

Code (`packages/worker/src/temporal/`):

- [ ] `ids.ts` — workflow-id builders exactly as in the target doc's workflow
      catalog. Every id starts with `userId`, except lanes and fan-out.
- [ ] `codec.ts` — payload codec using `aws/kms-envelope.ts`, context
      `{ userId, namespace }`. Search attributes carry only `userId`, `surface`,
      `packageId` and `status`.
- [ ] `client.ts` — Temporal client factory; front door and MCP server use only
      this to write.
- [ ] `worker.ts` — one worker per task queue: `app`, `platform`, `runtime`,
      `ops`.
- [ ] Workflows, one file each, with activities in `activities/`:
  - `ExecuteRun`, `PackageInvocation`, `JobRun`
  - `PackageWorkflowRun` (replaces the Cloudflare Workflow in
    `package-runtime/package-workflows.ts`)
  - `WebhookDelivery`, `EventFanout`, `PublishPackage`, `HumanApproval`,
    `AccountDelete`
  - `McpServerConnection` (entity), `InboundEmail` / `OutboundEmail`
  - one maintenance lane as the pattern for the rest
- [ ] Idempotency: the start path checks the idempotency table in
      `aws/dynamo-runs.ts` first (90-day contract), then relies on workflow-id
      uniqueness.
- [ ] Replace the `JobManager` DO and `JOBS_DB` cron dispatch with Temporal
      Schedules. Queue consumers become workflow Starts, and `ctx.waitUntil`
      deferred work becomes fire-and-forget Starts.
- [ ] Delete `queue-handler.ts`, `jobs/jobs-host.ts`,
      `billing/stripe-plan-refresh-do.ts`, `test-support/jobs-service*.ts`,
      `cloudflare-workflows-stub.ts` once unused.

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

| Phase    | Date       | node-unit pass / fail / skip | Acceptance green | Notes                                                                                                                              |
| -------- | ---------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Baseline | 2026-09-30 | 3,624 / 2 / 0                | —                | Node v26.10.0; 1,088 files passed and 2 failed; workers-unit reference unresolved (see P0).                                        |
| P0       | 2026-09-30 | 3,624 / 2 / 0                | —                | PGlite RLS, Temporal time skipping, AgentCore SDK and worker typecheck passed; `validate` has checkout and existing gate failures. |
| P1       |            |                              | —                |                                                                                                                                    |
| P2       |            |                              | 0 / 10           |                                                                                                                                    |
| P3       |            |                              |                  |                                                                                                                                    |
| P4       |            |                              |                  |                                                                                                                                    |
| P5       |            |                              |                  |                                                                                                                                    |
| P6       |            |                              |                  |                                                                                                                                    |
| P7       |            |                              |                  |                                                                                                                                    |
| P8       |            |                              | 10 / 10          |                                                                                                                                    |

## Known failures (pre-existing at baseline)

- `tools/check-migrations.node.test.ts`: this checkout has no trusted Git base
  (`origin/main` history), so `checkMigrationsDirectory()` cannot verify the
  post-baseline ledger.
- `packages/worker/src/capability-maintenance.node.test.ts`:
  `.github/workflows/deploy.yml` is absent from this checkout.

## Deleted tests log

| Path | Recipe rule | Reason |
| ---- | ----------- | ------ |

## Decisions and deviations

| Date       | Phase | Decision                                                                                                         | Why                                                                                                        |
| ---------- | ----- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | plan  | Rewrite tests in place; delete Cloudflare-only tests and packages                                                | POC targets the new stack only                                                                             |
| 2026-09-30 | plan  | In-process fakes (PGlite, Temporal time-skipping env, in-memory AWS fakes)                                       | No Docker needed; runs in the sandbox                                                                      |
| 2026-09-30 | plan  | Keep D1-shaped `prepare/bind` facade over Postgres                                                               | Avoids touching the query call sites across ~2,600 source files in a POC                                   |
| 2026-09-30 | plan  | All new code in `packages/worker/src/*`, not separate packages                                                   | Fewest moving parts for the POC; split later                                                               |
| 2026-09-30 | plan  | Data copy, cutover and decommission (target doc phases 4–6) out of scope                                         | POC proves the architecture, not the migration of live data                                                |
| 2026-09-30 | P0    | Use `@electric-sql/pglite-pgvector` for `vector`; keep the normal node suite's two checkout failures as baseline | PGlite publishes pgvector separately; this checkout lacks Git history and `.github/workflows/deploy.yml`   |
| 2026-09-30 | P0    | Skip persistent `core.hooksPath` configuration; use hook-free npm commands                                       | The actual `.git` belongs to the parent repository outside the writable project root                       |
| 2026-09-30 | P0    | Run and retain `npm run validate` as the authoritative local gate                                                | AGENTS.md explicitly overrides the plan's earlier instruction to avoid it; P0 found baseline gate failures |

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
