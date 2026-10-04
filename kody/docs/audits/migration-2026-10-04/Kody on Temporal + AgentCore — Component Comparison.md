> Historical evidence preserved on 2026-10-04. Commands and topology below
> describe the recorded phase, not current demo instructions.

# Kody on Temporal + AgentCore — Component Comparison

Sep 29, 2026

## Scope and locked decisions

Every Kody Cloudflare Worker script becomes Temporal workers on AWS behind a
thin front door that only starts, signals, updates or queries workflows.
AgentCore is the agent-facing infrastructure, and Bedrock supplies embeddings.
The baseline is the Kody Architecture Component Reference at commit `edc1189`.

| Decision           | Choice                                                                                                             | What it forces                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Compute model      | Every Worker script is replaced by Temporal workers; the front door holds no business logic                        | Synchronous paths (page render, `/mcp`, OAuth) must run as workflow Updates or short workflows (see Tensions) |
| Orchestration      | Temporal is the only durable-execution and orchestration layer                                                     | Durable Object alarms, Cloudflare Workflows, Queues and Cron Triggers all retire                              |
| Agent model        | Bring-your-own-agent stays; Kody runs no chat model                                                                | AgentCore is used as infrastructure: Runtime, Gateway, Identity, Memory, Code Interpreter, Observability      |
| Models             | Bedrock for embeddings only                                                                                        | Replaces Workers AI embeddings for memory and search                                                          |
| Temporal hosting   | Temporal Cloud and self-hosted on AWS, compared side by side                                                       | Section 12                                                                                                    |
| Infrastructure     | Cloudflare storage and platform services move to AWS managed services                                              | Frozen key contracts in `data-storage.md` must be preserved or rewritten                                      |
| Worker language    | TypeScript (assumed)                                                                                               | Most of `packages/worker/src` can move into activities                                                        |
| Product invariants | Per-user isolation, fail-closed chokepoints, compact `search`/`execute` MCP surface, agent code never sees secrets | Every AWS and AgentCore choice is checked against these                                                       |

Out of scope: the enterprise tenant layer (org entity, SSO, SCIM), a code-level
implementation plan, and cost modelling.

## Packages today: how they run and where they live

A package is a git repo with runtime switched on. Its source sits in a
Cloudflare Artifacts repo, its data in one SQLite `StorageRunner` bucket, and
all seven of its surfaces run in the same Worker Loader sandbox. Every trigger
already ends in one run path, which makes the package the natural unit for
Temporal to orchestrate. Sources: `docs/use/packages.md` and
`docs/contributing/packages-and-manifests.md` at `edc1189`.

**What a package is made of, and which component holds each part**

| Part              | What it holds                                                                                                 | Where it lives today                                                                                          | Script                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Source            | Code, `package.json` (the manifest), required `README.md` and `AGENTS.md`                                     | Cloudflare Artifacts git repo; D1 `entity_sources` (HEAD, `published_commit`) and `saved_packages` projection | `kody-platform`                     |
| Config            | `package.json#kody` metadata; package-scoped secrets mounted by `kody.secretMounts`                           | Manifest in the repo; D1 `secret_entries` and `secret_buckets` keyed by package id                            | origin, platform                    |
| Storage           | One SQLite bucket per package per user; `packageStorage()` offers get, set, list, sql (1,000-row cap), delete | `StorageRunner` Durable Object keyed `[userId, storageId]`                                                    | `kody-runtime`                      |
| Published bundles | esbuild output per export, job, handler and app; static `kody:@` dependencies captured as snapshots           | `BUNDLE_ARTIFACTS_KV` plus D1 `published_bundle_artifacts`                                                    | platform writes, runtime reads      |
| Exports           | Callable modules; the default export runs on direct invocation                                                | Loaded from bundles into a Worker Loader isolate                                                              | `kody-runtime`                      |
| Jobs              | Cron or interval schedules, each run with a job-scoped scratch bucket                                         | D1 `JOBS_DB` rows; one `JobManager` alarm per user                                                            | `kody-jobs`, then origin `JobsHost` |
| Webhooks          | Inbound POST bound to an export                                                                               | D1 `webhook_endpoints`; queue `kody-webhook-dispatch`                                                         | origin                              |
| Subscriptions     | A handler per event topic (`email.message.received`, `run.error.recorded`, `repo.pushed` and others)          | Queue `kody-package-events-dispatch`                                                                          | origin consumers                    |
| Workflows         | Deferred one-shot code via `workflows.create`                                                                 | Cloudflare Workflow `DynamicCallableWorkflow`                                                                 | `kody-runtime`                      |
| Retrievers        | Read-only search or context contributors; 3 s / 1 s budgets, 20 results max                                   | KV manifest and scope indexes                                                                                 | `kody-platform` (MCP search)        |
| App               | Fetch handler, optional browser client and static assets at `{user}.kody.run/packages/<name>`                 | Worker Loader isolate; `PackageAppRuntimeBridge` and `PackageRealtimeSession` Durable Objects                 | `kody-runtime`                      |
| Search entries    | Exports with their JSDoc, embedded                                                                            | Vectorize, per-user namespace                                                                                 | `kody-platform`                     |
| Run history       | Every run on every surface                                                                                    | `RunLog` Durable Object per user                                                                              | `kody-runtime`                      |

**Lifecycle from edit to run**

1. **Edit.** Agents without a filesystem use a repo session: a `RepoSession`
   Durable Object on platform with a file-level API and R2 spill. Agents with
   git mint a short-lived Artifacts remote with `packageGetGitRemote`; files
   over 10 MiB are rejected.
2. **Check.** Manifest schema, required docs, `kody.dependencies` matching the
   static imports with no cycles, optional typecheck when a root `tsconfig.json`
   exists, and bundle validation of npm dependencies in an isolated check
   runner.
3. **Publish.** `published_commit` advances, bundles rebuild into KV (unchanged
   targets are copied, not rebuilt), Vectorize reindexes, and jobs, webhooks and
   subscriptions resync. A locked package stops at an approval URL that the
   owner must click. A 5-minute reconcile lane publishes pushed but unpublished
   unlocked packages.
4. **Run.** Every surface loads the published bundle into an isolate with no
   parent `env`. Egress goes through `KodyFetchGateway`, and the run is written
   to `RunLog`.

**Rules the migration must carry over**

- **Authority comes from provenance.** Publish stamps each module with the
  package it came from. Storage buckets and locked secrets follow that stamp
  across static imports, and code cannot claim another package's id. The new
  sandbox must receive the stamp from the host, never from user code.
- **Composition is by snapshot.** Static `kody:@` imports freeze the
  dependency's bundle at publish (ADR 0021). Git history is the only versioning
  (ADR 0001), and authors have no `packages.invoke` (ADR 0037).
- **The runtime contract is Workers-shaped.** npm dependencies must bundle for
  Workers, an app entry is a `fetch` handler, and `kody:runtime` is supplied by
  the host at run time. Leaving Workers means keeping a Workers-compatible
  runtime inside the new sandbox, or migrating every user's packages with a
  platform codemod (the `package-codemods/` mechanism already exists).
- **Change control already exists.** Publish lock with approval URL, and
  codemods that commit on locked packages without publishing, are ready-made
  gates for a Temporal publish workflow.

**How each part could map to the new stack** (candidates; sections below compare
them in depth)

| Part                    | Today                                           | Target candidate                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check and publish       | `RepoSession` Durable Object plus check runner  | A `PublishPackage` Temporal workflow: checkout, checks, bundle, reindex and trigger sync as activities; a locked package waits on an approval Signal                                                    |
| Export and handler runs | `runSavedPackageModuleOnce` in a Loader isolate | One Temporal activity type that runs the bundle in AgentCore Code Interpreter or Runtime (Code Mode section)                                                                                            |
| Jobs                    | `JobManager` alarm                              | A Temporal Schedule per package job                                                                                                                                                                     |
| Workflows               | Cloudflare Workflows                            | Native Temporal workflows                                                                                                                                                                               |
| Webhooks                | Origin route plus queue                         | Front door starts a workflow whose id is the idempotency key                                                                                                                                            |
| Subscriptions           | Queue fan-out                                   | An event workflow that starts one child run per subscribed package                                                                                                                                      |
| Retrievers              | Read-only isolate                               | Activity in a sandbox with no egress (Code Interpreter in VPC mode)                                                                                                                                     |
| App                     | `kody.run` subdomain, Loader isolate            | AgentCore Runtime session per user and package over HTTP, or containers on ECS                                                                                                                          |
| Storage                 | `StorageRunner` SQLite                          | Open decision: the `sql()` contract needs a SQL store (Aurora PostgreSQL with row-level security, or SQLite files served by a storage service)                                                          |
| Published bundles       | KV                                              | S3, keyed by commit and immutable, with a DynamoDB index                                                                                                                                                |
| Source                  | Cloudflare Artifacts                            | AWS CodeCommit, which returned to general availability in November 2025, with repo-scoped STS credentials replacing Artifacts tokens; to verify: repositories-per-account quota at one repo per package |
| Run history             | `RunLog`                                        | Temporal history and Visibility plus a per-user run table (Observability section)                                                                                                                       |

## Target shape at a glance

&#91;embedded content: target shape · 2 front doors, 4 task queues, AgentCore,
egress proxy, AWS stores\]

Callers reach Kody only through the two front doors, which turn each request
into a Temporal Start, Signal or Update. The `runtime` queue runs user code as
an activity inside AgentCore, and that code reaches the outside world only
through the egress proxy, the one component allowed to decrypt secrets with KMS
and read tokens from AgentCore Identity. All worker pools read and write the AWS
stores.

## Worker scripts to Temporal workers

Six of the eight Cloudflare scripts become Temporal worker pools, one task queue
each; the Nx cache and the front door are the only non-Temporal compute left.
The front door holds no business logic: it authenticates the transport, turns
the request into a workflow Start, Signal, Update or Query, and returns the
result.

| Script today                 | What it does today                                                                                                                                                    | Temporal replacement                                                                                                                                                                                    | Other pieces it needs                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kody-production` (origin)   | Remix UI, `/mcp`, OAuth, inbound email, 7 queue consumers, `JobsHost`                                                                                                 | `app` task queue: page loaders, auth and OAuth handlers as short workflows answered by Update-with-Start; queue consumers become workflows; `JobsHost` disappears because jobs call activities directly | Front door (ALB or API Gateway to a small HTTP service on ECS Fargate); CloudFront for static assets; `/mcp` on AgentCore (MCP section); SES for inbound mail |
| `kody-platform`              | 9 Durable Objects: `MCP`, `McpClientHub`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`, `OAuthPurgeCoordinator`, `KodyFetchGateway` | `platform` task queue: per-user actors become entity workflows or plain tables (Durable Objects section)                                                                                                | DynamoDB, Aurora, AgentCore Gateway and Identity                                                                                                              |
| `kody-runtime`               | Package apps, invocation API, `StorageRunner`, `RunLog`, `DynamicCallableWorkflow`                                                                                    | `runtime` task queue: one activity type runs a package bundle inside AgentCore; Cloudflare Workflows replaced by native workflows                                                                       | AgentCore Code Interpreter and Runtime; the storage store for `packageStorage()`                                                                              |
| `kody-jobs`                  | `JobManager` alarm per user, `JOBS_DB`, 5-minute cron fan-out                                                                                                         | Script retires: Temporal Schedules start job workflows on the `runtime` queue; maintenance lanes become one Schedule each on an `ops` queue                                                             | Nothing extra                                                                                                                                                 |
| `kody-highlight`             | Stateless Shiki `POST /highlight`                                                                                                                                     | Activity on a `highlight` queue, called from render workflows                                                                                                                                           | A candidate for Temporal Serverless Workers on Lambda (spiky, stateless)                                                                                      |
| `kody-status`                | Minute probes, `StatusStore` Durable Object, `status.kody.codes`                                                                                                      | A 1-minute Schedule running probe activities; results in DynamoDB; page served from S3 and CloudFront                                                                                                   | An outside probe (CloudWatch Synthetics) so the page still works when Temporal itself is down                                                                 |
| `kody-production-d1-backups` | D1 backup, seal-day and restore Workflows into object-locked R2                                                                                                       | `ops` queue workflows for signed manifests and restore drills                                                                                                                                           | AWS Backup and S3 Object Lock do most of the copying natively                                                                                                 |
| `kody-nx-cache`              | Nx remote cache on R2                                                                                                                                                 | Not a Temporal worker; CI tooling                                                                                                                                                                       | S3-backed Nx cache                                                                                                                                            |

**Where the worker pools run.** Long-lived pools (`app`, `platform`, `runtime`,
`ops`) fit ECS Fargate services that autoscale on task-queue backlog. Temporal's
[Serverless Workers for AWS Lambda](https://temporal.io/blog/durable-digest-august-2026)
are in Public Preview for Temporal Cloud only: Temporal invokes the uploaded
Lambda and it scales to zero when idle. That suits bursty, stateless queues such
as `highlight` and the maintenance lanes, but it is not an option on self-hosted
Temporal.

**Deploy scoping carries over.** Today a UI-only change uploads origin alone.
With one task queue per former script, each pool deploys on its own, and Worker
Versioning pins running workflows to the build that started them, which replaces
the fixed `deploy.yml` upload order.

## Durable execution and orchestration

Kody hand-builds durability out of five Cloudflare primitives (Durable Object
alarms, Workflows, Cron Triggers, Queues with DLQs, and the `RunLog` ledger);
Temporal replaces all five with one model. The one hard rule: user or agent code
never runs as Temporal workflow code. Workflow code must be deterministic and
trusted, so every workflow is platform-owned, and user code only ever runs
inside an activity that calls the sandbox.

| Mechanism today         | How it works today                                                                                                                                   | Temporal replacement                                                                                                                      | What improves                                                                                                                                                                             | Watch out for                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-user job scheduling | One `JobManager` alarm per user, set to the next due job in `JOBS_DB`; re-arms 1 s out to drain backlogs                                             | One Temporal Schedule per package job (cron or interval, timezone, pause, overlap and catch-up policies); each fire starts a job workflow | No hand-rolled alarm or backlog logic; pause and trigger-now come built in (`jobRunNow`, kill switch, `expires_at`)                                                                       | Plan interval floors (15 min Free and Standard, 5 min Pro) are checked when the Schedule is created or updated                                                    |
| Deferred and long work  | `DynamicCallableWorkflow`: one sandbox run after `runAt`, \~4.5 min budget, 3 retries, 5-minute step timeout                                         | A platform `PackageWorkflowRun`: timer until `runAt`, then one sandbox activity with a retry policy and heartbeats                        | The 4.5-minute cap goes away; the limit becomes the sandbox session (up to 8 h). Kody's replay workarounds (elapsed time captured inside steps, outcome-named steps) are no longer needed | `concurrent_workflows` quota is still enforced before start                                                                                                       |
| Maintenance lanes       | Cron `*/5` fans 21 lanes onto `kody-scheduled-dispatch` with a DLQ; inline fallback if enqueue fails                                                 | One Schedule per lane on the `ops` queue; activity retry policies replace the DLQ                                                         | Failed lanes stay visible and can be reset or re-run; no queue-outage fallback path to maintain                                                                                           | Lanes that page through large tables use Continue-As-New to keep histories small                                                                                  |
| Origin queues           | 7 queues with DLQs (email delivery events, Artifacts repo events, feedback, community activity, community listing, package events, webhook dispatch) | Each producer starts a workflow or sends a Signal instead of enqueueing                                                                   | One retry and visibility model instead of seven consumers                                                                                                                                 | High-volume producers (email delivery events) need batching to control action counts                                                                              |
| Inbound webhooks        | `ack` mode enqueues and returns 202; `sync` mode invokes inline                                                                                      | `ack`: front door starts a workflow whose id is the delivery id, then returns 202. `sync`: Update-with-Start waits for the result         | Duplicate deliveries are rejected by workflow-id uniqueness                                                                                                                               | HMAC and replay-window checks stay in the front door, before any start                                                                                            |
| Subscriptions           | `kody-package-events-dispatch` queue fans an event to subscribed packages                                                                            | An event workflow starts one child workflow per subscribed package                                                                        | Per-subscriber retries and history; one slow handler no longer blocks the others                                                                                                          | Admin-only topics keep their role check before fan-out                                                                                                            |
| Idempotency ledger      | `RunLog` Durable Object claims keys serially; terminal responses cached 90 days                                                                      | Workflow id = `{userId}:{surface}:{Idempotency-Key}`; a duplicate start returns the existing run                                          | No hand-written claim logic                                                                                                                                                               | Id uniqueness lasts only while the closed run is retained. Keeping the 90-day replay contract needs a retention setting to match or a small DynamoDB result cache |
| Publish pipeline        | `RepoSession` Durable Object runs checks, rebuild, reindex and sync inline; reconcile lane is a safety net                                           | A `PublishPackage` workflow; locked packages wait on an approval Signal from the website                                                  | Each phase retries on its own; the approval gate becomes durable state instead of a URL-only convention                                                                                   | Check runs call the sandbox, so they count against sandbox capacity                                                                                               |

**New operator controls that come free.** Temporal has added
[Activity Operations and Workflow Pause](https://temporal.io/blog/durable-digest-august-2026)
(Public Preview and Pre-Release in August 2026): pause, reset or change the
retry policy of one misbehaving activity, or pause a whole workflow while
Signals queue up. Kody today can only cancel a run.

**Opportunity.** Because user runs become activities inside platform workflows,
a later `steps` API could let package code declare several durable steps, each
its own activity, without ever letting user code become workflow code.

## Durable Objects

Kody's 15 Durable Object classes give two things at once: serialized per-user
state and storage. In the new stack those split. Temporal entity workflows (one
long-running workflow per user or session, driven by Signals and Updates) take
the coordination; DynamoDB, Aurora and S3 take the data. An entity workflow is
not a database: its history grows with every event and needs Continue-As-New, so
anything queried or kept long goes to a store.

| Durable Object            | State it holds                                                                    | Target                                                                                                                                                                  | Why this target                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `JobManager`              | Next-due alarm                                                                    | Retires; Temporal Schedules                                                                                                                                             | Scheduling is native                                                                                                              |
| `RunLog`                  | Run history, idempotency ledger, workflow projections, 90-day retention           | Temporal Visibility (search attributes `userId`, `surface`, `status`) for recent runs, plus a DynamoDB runs table with TTL; log lines in S3                             | Runs are already workflows; long retention and 200-line logs outgrow history                                                      |
| `UserMeter`               | Atomic daily counters, storage-byte reservation, deletion tombstone, write leases | DynamoDB item per user and counter with conditional atomic updates                                                                                                      | It sits on every `execute` and every fetch; a workflow Update per call would add latency and Temporal actions to the hottest path |
| `Mailbox`                 | Parsed mail, delivery ledger, retention                                           | Aurora tables for messages (they are queried and paged); S3 for raw MIME; retention as a Schedule                                                                       | Relational, queryable data                                                                                                        |
| `McpClientHub`            | Remote MCP registrations, OAuth client records, tokens                            | AgentCore Identity token vault for per-user OAuth tokens; registrations in DynamoDB; an entity workflow per user only for reconnect and backoff state                   | Identity is built for outbound OAuth on a user's behalf (MCP section)                                                             |
| `RepoSession`             | Editing workspace (`@cloudflare/shell` with R2 spill)                             | An AgentCore session whose microVM filesystem is the workspace, keyed by the repo session id, plus a `RepoSession` entity workflow for idle timeout, commit and publish | A real filesystem replaces the shell emulation (ADR 0020); sessions last up to 8 hours                                            |
| `RepoSessionIndex`        | Session catalog, conversation resume                                              | DynamoDB (`userId`, `conversationId` to session)                                                                                                                        | Plain lookup                                                                                                                      |
| `StripePlanRefresh`       | One-shot reconcile alarm                                                          | A workflow timer started by the Stripe webhook                                                                                                                          | Native                                                                                                                            |
| `StorageRunner`           | SQLite bucket per package per user                                                | Open decision (below)                                                                                                                                                   | The `sql()` contract drives it                                                                                                    |
| `PackageRealtimeSession`  | WebSocket state for package apps                                                  | API Gateway WebSocket API with a DynamoDB connections table                                                                                                             | Managed WebSocket fan-out                                                                                                         |
| `PackageAppRuntimeBridge` | Bridges app requests into the runtime                                             | Part of the package-app host (Code Mode section)                                                                                                                        | Folds into the host                                                                                                               |
| `MCP`                     | Sessionful 2025-era MCP lane                                                      | Retires; stateless lane only, as ADR 0005 already plans                                                                                                                 | AgentCore Runtime handles `Mcp-Session-Id` stickiness if a sessionful lane is ever kept                                           |
| `OAuthPurgeCoordinator`   | Coordination                                                                      | A Schedule                                                                                                                                                              | Native                                                                                                                            |
| `KodyFetchGateway`        | Egress for sandboxed code                                                         | An egress proxy service (Code Mode and Identity sections)                                                                                                               | Must sit on the network path, not in a store                                                                                      |
| `StatusStore`             | Status page state                                                                 | DynamoDB                                                                                                                                                                | Plain store                                                                                                                       |

**Keeping isolation structural.** A Durable Object named by `userId` made
cross-user reads impossible because the object was the user. The AWS equivalent
is a DynamoDB partition key of `userId` plus per-request IAM session policies
with the `dynamodb:LeadingKeys` condition, so a worker holding one user's
credentials cannot read another partition. Temporal workflow ids and search
attributes carry `userId` the same way.

**`StorageRunner` options** (the `sql()` API exposes SQLite dialect to user
code, so the choice is not cosmetic):

| Option                                                                                                  | Keeps `sql()` as is                                    | Isolation               | Cost of the choice                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------- |
| SQLite file per bucket on S3 or EFS, opened by a storage service with a single-writer lease in DynamoDB | Yes                                                    | One file per bucket     | Kody builds and runs the storage service and its lease logic      |
| Aurora PostgreSQL, a schema and role per bucket                                                         | No: dialect changes; needs a codemod                   | Database roles          | Thousands of schemas; connection pooling and migrations get heavy |
| Aurora PostgreSQL, shared tables with row-level security                                                | No: arbitrary user SQL against shared tables is unsafe | Row-level security only | Would have to drop raw `sql()` for a narrower API                 |
| DynamoDB                                                                                                | No: `sql()` is replaced by get, set and list           | Partition key           | Breaks every package that uses `sql()`                            |

## Code Mode vs AgentCore Runtime and Code Interpreter

AgentCore gives a stronger isolation boundary (a microVM per session instead of
a V8 isolate), a real filesystem and runs of up to 8 hours. Kody's Code Mode
wins on startup density and on a per-request egress hook. The design task is to
keep Kody's three guarantees on AgentCore: no route to secrets, every capability
call re-checked by a broker, and all egress through the gateway.

| Attribute                | Kody Code Mode today                                                 | AgentCore Code Interpreter                                                                                                                                                                     | AgentCore Runtime                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation unit           | V8 isolate per user and module graph; no parent `env`                | Dedicated microVM per session; memory sanitized at the end ([session docs](https://docs.aws.amazon.com/it_it/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)) | Dedicated microVM per `runtimeSessionId` ([sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html))                                                          |
| Warm reuse               | Stable Dynamic Worker id from user, storage context and module graph | Reuse within one session                                                                                                                                                                       | Reuse by session id; idle timeout defaults to 15 minutes ([startup latency](https://repost.aws/articles/ARCJIn3t7aRC2FxiRTV1SuCA/minimizing-startup-latency-with-amazon-bedrock-agentcore-runtime)) |
| Longest run              | 90 s for `execute`; \~4.5 min for workflow runs                      | Session default 15 minutes, configurable up to 8 hours                                                                                                                                         | Up to 8 hours per microVM ([lifecycle settings](https://docs.aws.amazon.com/fr_fr/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.md)); up to 14 days on Runtime Instances             |
| Languages                | JavaScript and TypeScript on the Workers runtime                     | Python, JavaScript, TypeScript; Node.js runtime added in 2026 ([release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html))                              | Any container, or direct deploy for Python and Node.js                                                                                                                                              |
| Network control          | `globalOutbound` sends every `fetch` to `KodyFetchGateway`           | Sandbox, Public or VPC mode ([network modes](https://docs.aws.amazon.com/de_de/bedrock-agentcore/latest/devguide/code-interpreter-resource-management.html)); no per-request hook              | VPC configuration; no per-request hook                                                                                                                                                              |
| Calls back into the host | RPC over service bindings to trusted handlers                        | None built in; code must call a Kody endpoint over the network                                                                                                                                 | Same                                                                                                                                                                                                |
| Secrets inside           | None                                                                 | None, unless the execution role grants AWS access                                                                                                                                              | Can reach AgentCore Identity; Kody must not grant it for user code                                                                                                                                  |
| File system              | None                                                                 | Session filesystem (write, list, read files)                                                                                                                                                   | Container filesystem, session-scoped                                                                                                                                                                |

**Known risk.** Researchers showed DNS-based exfiltration from Code
Interpreter's Sandbox mode, and AWS now recommends VPC mode for complete network
isolation
([Unit 42](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/)).
Kody's deny-by-default egress therefore needs VPC mode, never Sandbox or Public.

**How the three guarantees carry over**

1. **All egress through the gateway.** The sandbox runs in VPC subnets with no
   NAT or internet route; the only reachable endpoint is the Kody egress proxy,
   and a Route 53 Resolver DNS Firewall allows only its name. The `kody:runtime`
   shim replaces `fetch` so each request is sent whole to the proxy, which
   substitutes `{{secret:…}}` placeholders, checks the host allowlist, consumes
   `outbound_fetches_per_day` and blocks Kody's own hosts. A transparent CONNECT
   proxy cannot do this, because it cannot see inside TLS.
2. **Brokered capability calls.** The Temporal activity that starts the run
   mints a short-lived token carrying `userId`, run id and the bundle's
   provenance stamps. `kody.*` calls from the sandbox go to a capability
   endpoint that re-checks that token on every call, replacing service-binding
   RPC.
3. **No route to secrets.** The sandbox's execution role has no Secrets Manager,
   KMS, AgentCore Identity or database permissions.

**Fit per Kody surface** (candidates to compare, not a decision)

| Kody surface                                                                | Candidate                                                | Why                                                 | Open point                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Ad hoc `execute`                                                            | Code Interpreter, called from an activity                | Short, untrusted, per call                          | Reuse a session per user and bundle hash to hide cold starts, or start fresh each time for unreviewed community code                       |
| Package exports, job runs, subscription and webhook handlers, workflow runs | Code Interpreter                                         | Same shape as `execute`, longer budgets             | Session keying, as above                                                                                                                   |
| Retrievers                                                                  | Code Interpreter in VPC mode with no routes at all       | Kody requires them to be closed-world and read-only | 1–3 s budgets are tight against a cold microVM                                                                                             |
| Repo sessions and publish checks                                            | Code Interpreter or Runtime session holding the checkout | Real filesystem, long sessions                      | Runtime if checks need a custom image (esbuild, TypeScript)                                                                                |
| Hosted package apps                                                         | Runtime (HTTP protocol), a session per user and package  | Long-lived HTTP host                                | Keep the Workers `fetch` contract by running `workerd` (the open-source Workers runtime) in the Runtime container, or codemod apps to Node |

**Compatibility decision.** Package code today targets the Workers runtime.
Running `workerd` inside the AgentCore container keeps every published package
working unchanged. Moving package code to Node opens the full npm ecosystem, but
needs a fleet-wide codemod (the mechanism exists) and a new runtime contract.

## MCP surface on AgentCore

The compact two-tool surface (`search`, `execute`) survives either way; the
choice is who terminates MCP. AgentCore Gateway gives managed inbound auth and
Policy on each tool call. A Kody MCP server hosted on AgentCore Runtime keeps
full control of per-user instructions, protocol eras and `structuredContent`.
Behind both, each tool call becomes a Temporal Update-with-Start on the `app` or
`runtime` queue.

| Concern                      | Kody today                                                                                 | Option A: AgentCore Gateway                                                                                                                                                                                                           | Option B: Kody MCP server on AgentCore Runtime                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                     | `/mcp` on origin; sessionful Durable Object lane plus stateless `2026-07-28` lane          | Gateway MCP endpoint with two targets, `search` and `execute`, each a Lambda that starts or updates a workflow                                                                                                                        | Kody's own stateless streamable-HTTP server in a Runtime container; Runtime expects stateless servers and routes by `Mcp-Session-Id` ([re:Post](https://repost.aws/questions/QU-YbedQP2Qj6QwqR5EnuELQ/how-to-maintain-session-state-across-http-requests-in-bedrock-agentcore-runtime-for-mcp-servers)) |
| Inbound auth                 | Kody's OAuth 2.1 server, CIMD and legacy dynamic registration; OIDC scopes only (ADR 0049) | Gateway acts as an OAuth resource server for any IdP, such as Cognito ([Gateway blog](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore-gateway-transforming-enterprise-ai-agent-tool-development/)) | Runtime JWT inbound auth against the same IdP                                                                                                                                                                                                                                                           |
| Tool-call authorization      | Fresh RBAC per request; fail closed on errors                                              | AgentCore Policy (Cedar-compatible, default deny) intercepts every tool call ([overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html))                                               | Kody's own checks in the server; Policy not in the path                                                                                                                                                                                                                                                 |
| Per-user server instructions | Assembled per user (`assemble-mcp-server-instructions.ts`)                                 | To verify: whether Gateway can return dynamic, per-user instructions                                                                                                                                                                  | Fully supported                                                                                                                                                                                                                                                                                         |
| Protocol versions            | 2025 and `2026-07-28`                                                                      | To verify: which MCP versions Gateway serves                                                                                                                                                                                          | Whatever Kody's SDK supports                                                                                                                                                                                                                                                                            |
| Limits Kody sets             | 100 KB response cap; `Server-Timing` phases                                                | Gateway limits apply                                                                                                                                                                                                                  | Kody controls them                                                                                                                                                                                                                                                                                      |

**Keep the compact surface.** Gateway's semantic tool search could expose all
\~200 capabilities as separate tools. That would reverse Kody's core design
choice of `search` plus `execute`, so both options keep capabilities behind
`execute`.

**Remote MCP servers Kody calls as a client** (`McpClientHub`). Gateway can
connect to existing MCP servers as targets, but targets are configured per
gateway, while Kody users add their own servers at runtime. Two candidates: a
Gateway target per user server (to verify: per-gateway target quotas and how
fast targets can be created), or Kody's `MCPClientManager` running in `platform`
workers with each user's tokens held in the AgentCore Identity token vault. The
second keeps `kody.mcp["server"]` semantics unchanged.

**Catalogs.** AgentCore Registry is a governed catalog of MCP servers, tools and
skills with review and approval. It fits an internal capability or package
catalog, but it is built for an organization, so it does not replace the public
community catalog.

## Identity, OAuth and secrets

AgentCore Identity works with any identity provider, so Kody does not have to
adopt Cognito: Kody's own OAuth 2.1 server can stay the issuer while Gateway and
Runtime validate its tokens. Identity's strongest fit is the outbound side,
holding each user's third-party OAuth tokens, which today live encrypted in D1.

| Kody component                              | Today                                                                                                | AWS or AgentCore candidate                                                                                                                                                                                                                                                                                                   | Notes                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| User identity key                           | `stable_user_id` = SHA-256 of the signup email; used in DO names, vectors, cookies                   | Unchanged; stored as a custom attribute if Cognito is used                                                                                                                                                                                                                                                                   | Changing it would break every frozen key contract                                                                                     |
| Browser sign-in                             | Password, TOTP, passkeys, GitHub, Google, X, Discord                                                 | Option 1: keep Kody's auth handlers as `app` activities. Option 2: Cognito user pools                                                                                                                                                                                                                                        | To verify: Cognito's fit for GitHub, X and Discord, which are not standard OIDC providers                                             |
| OAuth 2.1 server for MCP hosts              | `@cloudflare/workers-oauth-provider`, CIMD, dynamic registration, refresh-family reuse, grants in KV | Keep Kody's server (grants in DynamoDB); AgentCore Gateway or Runtime validate its JWTs ([Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) accepts any IdP)                                                                                                           | To verify: Cognito support for CIMD and dynamic client registration before choosing it                                                |
| Revocation                                  | Epoch fence on `password_changed_at`                                                                 | Same check in the front door and on every workflow start                                                                                                                                                                                                                                                                     | Works with any issuer                                                                                                                 |
| User secrets                                | AES-GCM with one `SECRET_STORE_KEY`, AAD `user:<userId>`, rows in D1                                 | KMS envelope encryption with encryption context `{userId}`, ciphertext in Aurora                                                                                                                                                                                                                                             | Encryption context plays the AAD role and is recorded in CloudTrail; KMS handles key rotation; the solo-operator key escrow goes away |
| Integration tokens                          | `user_integrations`, `user_oauth_apps`; refresh via `integrationTokenRefresh`                        | AgentCore Identity OAuth2 credential providers and token vault ([Identity guide](https://hidekazu-konishi.com/entry/amazon_bedrock_agentcore_implementation_guide_part2_security.html)); Consent Portal for user consent ([release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html)) | Only the egress proxy may fetch a token, and only after `required_hosts` and `usage_mode` checks pass                                 |
| Remote MCP server tokens                    | Stored only inside `McpClientHub`                                                                    | AgentCore Identity token vault                                                                                                                                                                                                                                                                                               | Same rule: never readable by sandboxed code                                                                                           |
| Host approvals, share and publish approvals | Human click in the signed-in UI                                                                      | Unchanged; a click sends a Signal to the waiting workflow                                                                                                                                                                                                                                                                    | Keeps "an agent can request, only a human can approve"                                                                                |
| RBAC                                        | `user` and `role` entities, checked fresh per request                                                | Unchanged, tables in Aurora; AgentCore Policy can add a default-deny gate on admin tool calls                                                                                                                                                                                                                                | Policy is extra defence, not a replacement                                                                                            |
| Credential rate limits                      | `AUTH_RATE_LIMITER` per IP                                                                           | AWS WAF rate-based rules on the front door                                                                                                                                                                                                                                                                                   | Managed                                                                                                                               |

**The egress proxy is the new trust anchor.** It replaces `KodyFetchGateway` and
is the only principal allowed to decrypt user secrets with KMS and to read
tokens from AgentCore Identity. Sandboxed code, the MCP endpoint and most
workers never get those permissions, so the rule "code sees only placeholders"
is enforced by IAM, not by convention.

## Memory and search

Kody's memories are written deliberately by the agent (verify first, then
upsert), while AgentCore Memory's long-term side is built to extract memories
automatically from conversation events with a model. Using AgentCore Memory
therefore means using it as a per-user record store with semantic retrieval, not
turning on extraction strategies that would change what Kody remembers.

| Concern                | Kody today                                                                        | Option A: AgentCore Memory                                                | Option B: Aurora plus a vector store                                              |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Record                 | Subject, summary, details, category, status, `dedupe_key`, `source_uris`; D1 rows | Long-term memory records under a per-user namespace                       | Aurora rows, unchanged schema                                                     |
| Write rule             | `metaMemoryVerify` must run before upsert or delete                               | Kody keeps the rule in its own capability; extraction strategies stay off | Unchanged                                                                         |
| Retrieval              | Top 1–2 by similarity; same `dedupe_key` collapses; subject and summary only      | Semantic retrieval scoped to the user's namespace                         | pgvector in Aurora, or OpenSearch Serverless for hybrid lexical and vector search |
| Isolation              | Vectorize namespace = `stable_user_id`, plus a `userId` filter                    | Namespace per user                                                        | `userId` filter plus row-level security or per-user indexes                       |
| Scale limit            | One index, 50,000-namespace cap; ADR 0047 accepts it until 5,000 users            | To verify: namespace and record quotas                                    | No namespace cap                                                                  |
| Embeddings             | Workers AI                                                                        | Managed by AgentCore Memory                                               | Bedrock embedding model (for example Titan Text Embeddings or Cohere Embed)       |
| Soft delete and export | Soft delete by default; JSON download                                             | To verify: soft delete and bulk export                                    | Unchanged                                                                         |

**One search index serves more than memory.** `search` also ranks \~200
capabilities, saved packages and exports, guides, jobs and connected MCP
servers, fusing vector and lexical scores before a rerank. Option B keeps all of
these in one store with one embedding model; Option A covers memories only, so
capabilities and packages still need Option B's store. Either way, vectors stay
derived data: switching embedding models is a full reindex from Aurora, which
Kody's current design already allows.

## Cloudflare infrastructure to AWS services

Every Cloudflare storage and platform service has a managed AWS counterpart; the
costly moves are D1 to Aurora (SQLite to PostgreSQL dialect across \~100 tables
and 71 migrations) and the frozen key formats listed in `data-storage.md`, which
must be kept or rewritten deliberately.

| Cloudflare service                     | Kody use                                                                     | AWS service                                                                                                                                                       | Migration note                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 `APP_DB`                            | All application tables                                                       | Aurora PostgreSQL (Serverless v2)                                                                                                                                 | Dialect rewrite of queries and migrations; forward-only migration discipline carries over                                                        |
| D1 `AUDIT_DB`                          | Hashed global audit trail                                                    | Separate Aurora database, exported to S3 with Object Lock                                                                                                         | Keeps the audit trail out of the app database's blast radius                                                                                     |
| D1 `JOBS_DB`                           | Job rows for `JobManager`                                                    | Retires; schedules live in Temporal, job config stays in Aurora                                                                                                   | Covered in Durable execution                                                                                                                     |
| KV `OAUTH_KV`                          | OAuth clients, grants, tokens                                                | DynamoDB with TTL                                                                                                                                                 | Library-managed today; Kody's OAuth server needs a DynamoDB adapter                                                                              |
| KV `BUNDLE_ARTIFACTS_KV`               | Published bundles, source snapshots, retriever indexes                       | S3 (commit-keyed, immutable) plus a DynamoDB index                                                                                                                | Bundles are read on every run; cache them in worker memory                                                                                       |
| R2 `EMAIL_BLOBS`, `REPO_SESSION_BLOBS` | Raw MIME, attachments, session spill                                         | S3                                                                                                                                                                | Direct move                                                                                                                                      |
| R2 `COMMUNITY_ASSETS`                  | Icons, OG images                                                             | S3 behind CloudFront                                                                                                                                              | Direct move                                                                                                                                      |
| R2 backups (object-locked)             | D1 backup manifests                                                          | AWS Backup for Aurora and DynamoDB, plus S3 Object Lock                                                                                                           | Most of the backup worker becomes configuration                                                                                                  |
| Vectorize                              | Capability, memory, package and job vectors                                  | See Memory and search                                                                                                                                             | Rebuilt from Aurora, not migrated                                                                                                                |
| Workers AI                             | Embeddings                                                                   | Bedrock embedding models                                                                                                                                          | Full reindex on switch                                                                                                                           |
| Artifacts                              | Git repos for every repo and package                                         | AWS CodeCommit, back to general availability since November 2025 ([AWS blog](https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability)) | To verify: repository quota per account; repo-scoped STS credentials replace short-lived Artifacts tokens; repo events trigger publish workflows |
| Email Routing and `EMAIL` binding      | Per-user inbox at `inbox.kody.codes`; outbound only to verified destinations | SES inbound receipt rules (to S3, then a workflow start) and SES outbound with event destinations for bounces and complaints                                      | Auto-pause rules (1 complaint or 5 bounces a day) run as workflow logic on SES events                                                            |
| Queues (8 plus DLQs)                   | Background dispatch                                                          | Temporal                                                                                                                                                          | Covered in Durable execution                                                                                                                     |
| Cron Triggers                          | Jobs, status, backups                                                        | Temporal Schedules                                                                                                                                                | Same                                                                                                                                             |
| Analytics Engine (8 datasets)          | Usage, flags, MCP lanes, search quality, onboarding funnel                   | Kinesis Data Firehose to S3, queried with Athena; CloudWatch embedded metrics for the few alerting series                                                         | High-volume sampled events belong in a lake, not in metrics                                                                                      |
| Rate-limit bindings                    | Auth and Sentry-tunnel limits                                                | AWS WAF rate-based rules                                                                                                                                          | Managed                                                                                                                                          |
| Edge cache (`caches.default`)          | 60-second cache for anonymous marketing pages                                | CloudFront cache policies                                                                                                                                         | Same semantics with stale-while-revalidate                                                                                                       |
| Static assets (`ASSETS`)               | UI bundles                                                                   | S3 plus CloudFront                                                                                                                                                | Direct move                                                                                                                                      |
| `IMAGES` binding                       | OG image generation                                                          | An activity using an image library, results cached in S3                                                                                                          | Small                                                                                                                                            |
| Wildcard `{user}.kody.run`             | Per-user package-app hosts on a separate apex                                | Route 53 wildcard record, ACM wildcard certificate, CloudFront or ALB host routing                                                                                | ADR 0017's separate registrable domain must stay                                                                                                 |
| Service bindings                       | Worker-to-worker RPC                                                         | Temporal task queues, and Nexus endpoints between namespaces (Nexus TypeScript support is GA per [Temporal](https://temporal.io/blog/durable-digest-august-2026)) | Nexus keeps ADR 0016's failure-domain split as explicit service contracts                                                                        |
| Cloudflare Access                      | Guards the DR admin UI                                                       | IAM Identity Center                                                                                                                                               | Operator-only                                                                                                                                    |
| Miniflare local dev                    | All scripts in one process                                                   | Temporal dev server plus Docker Compose (Postgres, LocalStack for S3 and DynamoDB)                                                                                | Code Interpreter sessions run in AWS, so local runs need a stand-in sandbox or a shared dev account                                              |

## Observability and metering

Temporal's event history turns Kody's hand-built run records into a by-product:
every run is a workflow with inputs, retries, failures and timings already
recorded. What Kody still owns is the user-facing view (`/account/activity`),
the metering that bills credits, and the audit trail.

| Kody layer           | Today                                                                      | New stack                                                                                                                                                                                                | What changes                                                                                             |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Run records          | `RunLog` per user across 9 surfaces; up to 200 log lines, truncated errors | Temporal Visibility with search attributes (`userId`, `surface`, `packageId`, `status`) for lists; DynamoDB runs table for the Activity page; logs in S3                                                 | `/account/activity` reads Kody's table, never Temporal directly, so user isolation stays in Kody's hands |
| Usage events and CPU | Analytics Engine plus `DynamicWorkerUsageTail` measuring Worker CPU        | Firehose to S3 and Athena; AgentCore session metrics (such as `ActiveSessionCount` in CloudWatch, per [release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html)) | Credits must be re-based on microVM session time instead of isolate CPU; the unit changes                |
| Entitlement meters   | `UserMeter` atomic counters                                                | DynamoDB conditional counters                                                                                                                                                                            | Covered in Durable Objects                                                                               |
| Audit log            | `kody-audit` D1                                                            | Separate Aurora database with S3 Object Lock export; CloudTrail for AWS-level actions                                                                                                                    | CloudTrail adds KMS decrypt and Identity token events per user                                           |
| Traces               | Sentry; ADR 0008 declined span-level tracing                               | Temporal OpenTelemetry interceptors plus AgentCore Observability (OpenTelemetry-compatible) into CloudWatch                                                                                              | One trace from MCP call to workflow to sandbox run becomes possible; ADR 0008 would need superseding     |
| Status page          | `kody-status` probes; execute health from real traffic                     | Schedule-driven probes plus CloudWatch Synthetics from outside                                                                                                                                           | The outside probe covers a Temporal outage                                                               |
| Alert lanes          | Emit admin-only events that operator packages subscribe to (ADR 0041)      | Unchanged pattern: lanes become Schedules that emit events into the subscription workflow                                                                                                                | Keeps "alerting is built on Kody packages"                                                               |
| Operator tooling     | Cancel only                                                                | Temporal UI, batch operations, reset, Activity Operations and Workflow Pause                                                                                                                             | Real incident levers for the first time                                                                  |

## Temporal Cloud vs self-hosted Temporal on AWS

Both run the same server code and the same worker code, so the choice is about
who operates the cluster, not about the design above. Temporal Cloud unlocks
Serverless Workers on Lambda; self-hosting keeps every byte in Kody's own AWS
account.

| Dimension                                            | Temporal Cloud (AWS region)                                                                                                                                                                                  | Self-hosted on AWS                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What you operate                                     | Workers only                                                                                                                                                                                                 | Workers plus the frontend, history, matching and worker services (EKS or ECS), the database and the Visibility store                                                                                                                                          |
| Persistence                                          | Managed                                                                                                                                                                                                      | Cassandra, MySQL or PostgreSQL; Aurora PostgreSQL is a common AWS choice. Visibility on PostgreSQL 12+, MySQL, Elasticsearch or OpenSearch ([Temporal docs](https://docs.temporal.io/self-hosted-guide/visibility))                                           |
| Availability                                         | Standard namespaces replicate across three availability zones with a 99.9% SLA ([xgrid](https://www.xgrid.co/resources/temporal-cloud-vs-self-hosted/)); multi-region High Availability namespaces available | Multi-cluster replication is asynchronous and self-operated ([Temporal docs](https://docs.temporal.io/tags/temporal-service))                                                                                                                                 |
| Private networking                                   | AWS PrivateLink endpoint in the namespace's region ([Temporal docs](https://docs.temporal.io/cloud/connectivity/aws-connectivity))                                                                           | Inside Kody's VPC                                                                                                                                                                                                                                             |
| Serverless Workers on Lambda                         | Public Preview, Cloud only ([Temporal](https://temporal.io/blog/durable-digest-august-2026))                                                                                                                 | Not available                                                                                                                                                                                                                                                 |
| Nexus, Projects, Workflow Pause, Activity Operations | Delivered as Cloud features ship                                                                                                                                                                             | Nexus available self-hosted; newer features arrive with server upgrades you schedule                                                                                                                                                                          |
| Data in payloads                                     | Leaves the account unless encrypted; a KMS-backed payload codec encrypts every payload before it reaches Temporal                                                                                            | Stays in the account                                                                                                                                                                                                                                          |
| Cost shape                                           | Consumption (actions and storage)                                                                                                                                                                            | Infrastructure plus operating labour; one third-party estimate puts break-even at about 30–50M actions a month for teams already running Kubernetes and Cassandra ([Automation Atlas](https://automationatlas.io/guides/temporal-cloud-vs-self-hosted-2026/)) |
| Fit with Kody's operations                           | Removes a stateful cluster from runbooks written for one operator                                                                                                                                            | Adds a stateful cluster, its upgrades and its DR to those runbooks                                                                                                                                                                                            |
| Switching later                                      | A documented migration path moves namespaces from self-hosted to Cloud with open-workflow replication ([xgrid](https://www.xgrid.co/resources/temporal-cloud-vs-self-hosted/))                               | To verify: a path from Cloud back to self-hosted                                                                                                                                                                                                              |

**Payload encryption is required on Cloud either way.** Workflow inputs will
include email metadata, package params and run results. A payload codec that
encrypts with KMS, keyed by `userId`, keeps Temporal Cloud from ever seeing
plaintext and matches the per-user AAD pattern Kody already uses for secrets.

## Tensions and open decisions

The locked choice (every Worker becomes Temporal workers behind a thin front
door) fits everything asynchronous. The risk sits on synchronous,
latency-sensitive paths, where every request now makes a round trip through
Temporal and, for sandboxed code, through a microVM. These are the decisions to
settle before a design is final.

| #   | Tension                                      | Why it matters                                                                                                                     | Options                                                                                                                                                                           |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Page renders and API reads through workflows | Each Update-with-Start adds Temporal round trips and billable actions to every page view; today a signed-in render is one D1 batch | (a) Short workflows answered by Update-with-Start, measured at p50 and p95 before committing. (b) Let the front door do read-only Aurora reads, which relaxes "no business logic" |
| 2   | Sandbox cold start                           | A new microVM session is seconds-scale against warm isolates; retrievers have 1–3 s budgets                                        | Session reuse per user and bundle hash; keep a warm session per active user; drop retrievers from `context` scope if budgets cannot be met                                        |
| 3   | Session reuse vs isolation between packages  | A reused session can hold files or globals from an earlier run of a different package                                              | Key sessions by user and bundle hash, reset the filesystem between runs, and give unreviewed community forks fresh sessions                                                       |
| 4   | Workflow history and payload limits          | Temporal caps a run's history (51,200 events or 50 MB) and single payloads (about 2 MB)                                            | Continue-As-New for entity workflows and paging lanes; pass S3 keys, never bundles or mail bodies, as payloads                                                                    |
| 5   | `StorageRunner` replacement                  | `sql()` exposes SQLite to user code                                                                                                | See the options table in Durable Objects                                                                                                                                          |
| 6   | Workers runtime contract                     | Every published package targets Workers                                                                                            | `workerd` inside AgentCore containers, or a fleet codemod to Node                                                                                                                 |
| 7   | MCP termination                              | Gateway brings Policy and managed auth; Runtime keeps per-user instructions and protocol control                                   | Verify Gateway's support for dynamic instructions and `2026-07-28` first                                                                                                          |
| 8   | Issuer for MCP tokens                        | Kody's server supports CIMD and dynamic registration                                                                               | Keep Kody's server unless Cognito is verified to support both                                                                                                                     |
| 9   | Billing units                                | Credits debit Dynamic Worker days and Durable Object rows read (ADR 0051); neither exists after the move                           | Re-base on sandbox session-seconds and store operations                                                                                                                           |
| 10  | AgentCore quotas                             | One session per active user and package multiplies concurrent sessions                                                             | To verify: concurrent-session and session-creation-rate quotas per account and region                                                                                             |

**Decision records affected**

- **Superseded by the move:** 0002 data placement (rewritten for AWS stores),
  0020 shell-based repo sessions (a microVM filesystem replaces it), 0034 origin
  owns no Durable Objects (no Durable Objects remain), 0047 Vectorize namespaces
  (vector store changes), 0051 credit units.
- **Likely superseded:** 0008 no span-level tracing (Temporal and AgentCore emit
  OpenTelemetry by default), 0005 dual MCP lanes (stateless-only arrives
  sooner).
- **Kept, and enforced differently:** 0016 failure-domain split (task queues and
  Nexus instead of scripts), 0017 separate apex for package apps, 0033 no
  user-as-conversation, 0042 no secret inputs, 0049 no per-capability scopes,
  0021 publish-gated composition.
- **To revisit:** 0025 no long-running services. AgentCore Runtime sessions of
  up to 8 hours, or 14 days on Runtime Instances, make a long-running package
  service technically possible.

## Selling points

The pitch in one line: Kody keeps its product (bring-your-own agent, two MCP
tools, per-user isolation, fail-closed) and trades five hand-built durability
mechanisms and a V8 sandbox for Temporal's durable execution, AgentCore's
microVM sandboxes and identity vault, and AWS's managed keys and stores.

| Platform  | What it does best in this design                                                                                            | Kody capability it strengthens                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Temporal  | One durability model replaces alarms, Cloudflare Workflows, cron fan-out, eight queues with DLQs and the idempotency ledger | Less platform code: `JobManager`, scheduled dispatch and the queue consumers go away                                |
| Temporal  | Activities with heartbeats and retry policies, timers of any length                                                         | User workflows lose the \~4.5-minute cap; a durable multi-step `steps` API becomes possible                         |
| Temporal  | Signals and Updates as durable waits                                                                                        | Human approvals (secret hosts, publish lock, shares) become state that survives deploys and restarts                |
| Temporal  | Full event history, Temporal UI, reset, batch operations, Workflow Pause, Activity Operations                               | Operators can pause, reset or fix one user's run instead of only cancelling it                                      |
| Temporal  | Worker Versioning and Nexus                                                                                                 | Independent deploys per former script, with explicit service contracts that keep ADR 0016's failure domains         |
| AgentCore | Code Interpreter and Runtime: a microVM per session, a real filesystem, runs up to 8 hours                                  | A stronger isolation boundary than a V8 isolate for agent-written and community code; real repo-session workspaces  |
| AgentCore | Identity token vault, credential providers and Consent Portal                                                               | Third-party OAuth tokens leave Kody's database; only the egress proxy can use them                                  |
| AgentCore | Gateway or Runtime as the MCP front, with managed JWT inbound auth                                                          | A managed, scalable `/mcp` endpoint that keeps the two-tool surface                                                 |
| AgentCore | Policy (Cedar-compatible, default deny) and OpenTelemetry Observability                                                     | A second, declarative gate on tool calls, and one trace from MCP call to sandbox run                                |
| AWS       | KMS encryption context per user                                                                                             | The single escrowed `SECRET_STORE_KEY` becomes managed, rotating, audited keys                                      |
| AWS       | IAM session policies with `dynamodb:LeadingKeys`                                                                            | Per-user isolation stays structural, as Durable Object naming made it                                               |
| AWS       | Bedrock embeddings, SES, CloudFront, WAF, CodeCommit, AWS Backup with S3 Object Lock                                        | Managed replacements for Workers AI, Email Routing, edge cache, rate limits, Artifacts and the custom backup worker |
