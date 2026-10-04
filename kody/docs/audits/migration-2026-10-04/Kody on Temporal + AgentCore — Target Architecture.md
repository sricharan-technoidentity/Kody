> Historical evidence preserved on 2026-10-04. Commands and topology below
> describe the recorded phase, not current demo instructions.

# Kody on Temporal + AgentCore — Target Architecture

Sep 29, 2026

This design moves today's Kody onto Temporal Cloud, Amazon Bedrock AgentCore and
AWS managed services. Every user, published package, webhook URL and MCP grant
carries over, and no package author or connected agent sees a change. It builds
on the [Component Reference](https://claude.ai/artifact/TctwTxzNRreHKhQEg7Q1Y6)
comparison at commit `edc1189` and settles the open decisions listed there.

## Decisions this design is built on

Three prior answers shape everything below. The locked choices come from earlier
work.

| Decision            | Choice                                                                                        | What it forces in this design                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatibility       | Existing users, data and published packages carry over; packages run unchanged                | The Workers runtime (`workerd`) runs inside AgentCore. The following stay byte-compatible: the `kody:runtime` contract, `{user}.kody.run` and webhook URLs, the frozen key formats, OAuth grants and the SQLite `sql()` API |
| Temporal hosting    | Temporal Cloud in an AWS region, reached over PrivateLink                                     | Every payload is encrypted before it leaves the account. No Temporal cluster is added to the one-operator runbooks                                                                                                          |
| Read/write split    | The front door reads the database directly; every write goes through Temporal                 | The front door is a read-only web tier. Every mutation is a workflow Start, Signal or Update                                                                                                                                |
| Mandatory platforms | AgentCore, Temporal and AWS services only                                                     | Nothing on Cloudflare remains after cutover                                                                                                                                                                                 |
| Agent model         | Bring your own agent; Kody runs no chat model                                                 | AgentCore is infrastructure only. Bedrock supplies embeddings                                                                                                                                                               |
| Product invariants  | Per-user isolation, fail closed, two MCP tools (`search`, `execute`), code never sees secrets | Every choice below is checked against these four                                                                                                                                                                            |
| Language            | TypeScript for workers and services                                                           | Most of `packages/worker/src` moves into activities and services with its logic intact                                                                                                                                      |

**Assumptions to confirm** (none change the shape of the design):

- The enterprise tenant layer is out of scope. Every key starts with `userId`,
  which leaves a clean slot for a `tenantId` prefix later.
- AgentCore is used where it is the best fit for a component, not everywhere.
  Two services are deferred with reasons (see AgentCore usage).
- There is one primary AWS region. It must offer AgentCore Runtime, Code
  Interpreter and Identity, and Temporal Cloud PrivateLink.

## Design rules

Nine rules govern every component. A proposal that breaks one needs a decision
record, as Kody's ADRs work today.

1. **Reads are direct, writes go through Temporal.** The front door reads
   through read-only database roles. Every mutation it triggers is a workflow
   Start, Signal or Update-with-Start. Writes by user code happen inside a run
   that is itself a Temporal activity.
2. **User code never runs as workflow code.** Workflows are platform-owned and
   deterministic. Package and agent code runs only inside AgentCore microVMs,
   called from an activity.
3. **Two isolation walls.** Each user gets their own microVM session; inside it,
   each module graph gets its own V8 isolate, as today. Two users never share a
   microVM.
4. **Only the egress proxy can see a secret.** It alone holds KMS decrypt and
   AgentCore Identity token access. IAM enforces this, not convention.
5. **Every call back into Kody is brokered.** Sandboxed code reaches Kody only
   through the capability broker. The broker re-checks a short-lived run token
   on every call.
6. **Isolation is structural.** `userId` leads every key: DynamoDB partition
   keys with `dynamodb:LeadingKeys` session policies, Aurora row-level security,
   S3 prefixes, KMS encryption context, Temporal workflow ids.
7. **Fail closed at every chokepoint.** The front door, broker, egress proxy and
   every workflow start re-check verification, suspension and the password
   epoch.
8. **Compatibility is tested, not promised.** Frozen key formats, the package
   runtime contract and public URLs have a conformance suite. It replays real
   published packages against the new stack before cutover.
9. **Large data travels by reference.** Temporal payloads carry ids and S3 keys,
   never bundles, mail bodies or storage pages.

## Target architecture at a glance

Callers reach Kody through three entry points. Every write lands in a Temporal
namespace, and every run of user code happens inside AgentCore.

&#91;embedded content: target architecture · callers, front, Temporal,
AgentCore, stores\]

Read top to bottom: requests arrive, Temporal turns writes into workflows, and
user code runs in the Runner. The Runner can only call the broker and the egress
proxy, which alone hold data and secret access.

## Component catalog

The target has 27 components in eight layers. Kody's own code runs in the front
door, app edge, MCP server, Runner, broker, egress proxy, storage cells,
realtime service and Temporal workers. Everything else is a managed service.

| Layer         | Component                  | Service                                                               | Replaces                                                                    | Role                                                                                                                             |
| ------------- | -------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Edge          | DNS and certificates       | Route 53, ACM                                                         | Cloudflare DNS                                                              | `kody.codes`, wildcard `*.kody.run` on its own apex (ADR 0017), `status.kody.codes`, MX for `inbox.kody.codes`                   |
| Edge          | CDN and firewall           | CloudFront, AWS WAF                                                   | Edge cache, `ASSETS`, rate-limit bindings                                   | Static assets from S3; 60-second cache for anonymous pages; rate rules on auth endpoints                                         |
| Front         | Web front door             | ECS Fargate (Node, Remix SSR) behind ALB                              | Origin `fetch` handler                                                      | Canonical-host checks, session and bearer auth, page renders from direct reads, OAuth endpoints; mutations become Temporal calls |
| Front         | Package-app edge           | ECS Fargate behind its own ALB                                        | Package-app routing on origin                                               | Serves `{user}.kody.run` only; handoff-token exchange; forwards app requests to the user's Runner session                        |
| Front         | MCP server                 | AgentCore Runtime (MCP protocol)                                      | `MCP` Durable Object plus stateless lane                                    | `search` and `execute` for both protocol eras; sticky sessions via `Mcp-Session-Id`                                              |
| Orchestration | Temporal Cloud             | Temporal Cloud namespaces over PrivateLink                            | Durable Object alarms, Cloudflare Workflows, Cron Triggers, Queues and DLQs | All durable execution, schedules, approvals and idempotency                                                                      |
| Orchestration | Worker pools               | ECS Fargate, one service per task queue                               | The eight Worker scripts                                                    | `app`, `platform`, `runtime` and `ops` task queues; Shiki highlighting becomes a library inside the front door                   |
| Orchestration | Event starter              | EventBridge rules plus a small Lambda                                 | Queue producers for Artifacts and SES events                                | Turns CodeCommit and SES events into workflow Starts                                                                             |
| Sandbox       | Kody Runner                | AgentCore Runtime (HTTP protocol), custom container with `workerd`    | Worker Loader isolates                                                      | Runs every package surface and ad hoc `execute`, unchanged                                                                       |
| Sandbox       | Repo workspaces and checks | AgentCore Code Interpreter (custom, VPC mode)                         | `RepoSession` on `@cloudflare/shell`, check runner                          | File-level editing sessions and publish checks (bundle, typecheck, lint)                                                         |
| Sandbox       | Capability broker          | ECS Fargate, internal ALB                                             | Service-binding RPC                                                         | Receives `kody.*` calls from the Runner, re-checks the run token, runs capability handlers                                       |
| Sandbox       | Egress proxy               | ECS Fargate, the only route to the internet from sandboxes            | `KodyFetchGateway`                                                          | Placeholder substitution, host allowlists, fetch quota, self-host block                                                          |
| Sandbox       | npm mirror                 | AWS CodeArtifact                                                      | Network access during checks                                                | The only package registry reachable from check sessions                                                                          |
| State         | Storage cells              | ECS on EC2 with EBS, Litestream replication to S3                     | `StorageRunner`                                                             | One SQLite file per bucket, single owner, `sql()` unchanged                                                                      |
| State         | Realtime service           | ECS Fargate, sticky by session key; state in DynamoDB                 | `PackageRealtimeSession`                                                    | WebSocket sessions for hosted package apps                                                                                       |
| State         | Relational store           | Aurora PostgreSQL Serverless v2 (app cluster; separate audit cluster) | D1 `APP_DB`, `AUDIT_DB`                                                     | Application tables, memories, mail, run index; row-level security by `userId`                                                    |
| State         | Key-value and counters     | DynamoDB                                                              | `UserMeter`, `OAUTH_KV`, `RunLog` ledger, indexes                           | Atomic quotas, OAuth grants, idempotency results, session catalogs                                                               |
| State         | Search index               | pgvector plus Postgres full-text in Aurora                            | Vectorize                                                                   | Memories, capabilities, packages, guides; hybrid ranking                                                                         |
| State         | Objects                    | S3 (Object Lock for audit and backups)                                | R2, `BUNDLE_ARTIFACTS_KV`                                                   | Bundles by commit, MIME, assets, logs, SQLite replicas                                                                           |
| State         | Source repos               | AWS CodeCommit                                                        | Cloudflare Artifacts                                                        | One repo per package or repo                                                                                                     |
| Identity      | Kody OAuth 2.1 server      | Kody code in the front door and `app` workers                         | Same, on Workers                                                            | Issuer for MCP hosts and CLI; grants in DynamoDB                                                                                 |
| Identity      | Credential vault           | AgentCore Identity                                                    | Integration and MCP-client tokens in D1 and `McpClientHub`                  | Third-party OAuth tokens and workload identities                                                                                 |
| Identity      | Keys                       | AWS KMS                                                               | `SECRET_STORE_KEY`, OIDC signing key                                        | Per-user envelope encryption; OIDC signing without exporting the private key                                                     |
| Messaging     | Email                      | Amazon SES (inbound receipt rules, outbound with event destinations)  | Email Routing, `EMAIL` binding                                              | Per-user inboxes, verified destinations, bounce and complaint events                                                             |
| Operations    | Telemetry lake             | Kinesis Data Firehose to S3, Athena                                   | Analytics Engine                                                            | Usage and product events                                                                                                         |
| Operations    | Traces, logs, metrics      | AgentCore Observability, CloudWatch, OpenTelemetry                    | Sentry, `DynamicWorkerUsageTail`                                            | One trace from MCP call to sandbox run                                                                                           |
| Operations    | Status page                | S3 plus CloudFront, CloudWatch Synthetics                             | `kody-status`                                                               | Outside probes that still work if Temporal is down                                                                               |

## Package runtime: existing packages run unchanged

Existing packages keep working because the Kody Runner runs `workerd`, the
open-source Workers runtime, inside an AgentCore Runtime microVM. It reuses
Kody's own executor there, so the runtime contract a package sees is the same as
today.

**Inside the Runner container**

- **Supervisor.** A small process that speaks AgentCore Runtime's HTTP contract
  (`/invocations` and `/ping` on port 8080, plus WebSocket for realtime). It
  hands each invocation to `workerd`.
- **Host worker.** Today's `mcp/executor.ts` and `package-runtime/module-graph*`
  code, running in `workerd`. It uses `workerd`'s Worker Loader to create one V8
  isolate per module graph. The isolate id is the same stable Dynamic Worker id
  as today (user, storage context, module graph), so warm reuse behaves the
  same.
- **`kody:runtime`.** The same module source, supplied by the host. Only its
  transport changes: capability calls, `packageStorage()`, `workflows.create`
  and `secretHeaders` go to the capability broker over HTTPS instead of
  service-binding RPC.
- **Egress.** Every loaded isolate's `globalOutbound` points at a loopback
  service in the host worker. That service forwards each whole request to the
  egress proxy with the run token. The proxy therefore sees every request before
  TLS, as `KodyFetchGateway` does today. The Runner's subnets have no NAT route.
- **Bundles.** The calling activity passes S3 keys and presigned read URLs for
  the exact published commit. The Runner caches bundles by content hash for the
  life of the session.

**Session model.** One Runner session per user, with `runtimeSessionId` derived
from `stable_user_id` plus a rotation epoch. The microVM separates users; V8
isolates separate a user's packages, exactly as today. Community code runs only
after the user forks and publishes it, so it is already the user's own package
when it runs. Session state is cache only. Losing a session costs a cold start,
never data.

**What the Runner is allowed to reach.** Its execution role can write CloudWatch
logs and nothing else: no S3, KMS, Secrets Manager, database or AgentCore
Identity permissions. Its network reaches three internal endpoints: the broker,
the egress proxy and S3 through a gateway endpoint limited to presigned reads.

**Provenance.** The activity that starts a run puts the bundle's provenance
stamps (which package each module came from) into the signed run token. The
Runner forwards the token; it cannot mint one. The broker decides storage
buckets and locked secrets from the token alone, so code still cannot claim
another package's id.

**How each surface reaches the Runner**

| Surface                                   | Entry                      | Path to the Runner                                                                  | Through Temporal                           |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| `execute`                                 | MCP server                 | Update-with-Start `ExecuteRun`, then a `runtime` activity invokes the Runner        | Yes                                        |
| Package export over HTTP, webhook handler | Front door                 | `PackageInvocation` workflow, then an activity                                      | Yes                                        |
| Subscription handler                      | Event workflow             | One child `PackageInvocation` per subscriber                                        | Yes                                        |
| Job run                                   | Temporal Schedule          | `JobRun` workflow, then an activity                                                 | Yes                                        |
| Package workflow (`workflows.create`)     | Broker                     | `PackageWorkflowRun`: timer, then an activity                                       | Yes                                        |
| Retriever                                 | MCP server during `search` | Direct invocation with a read-only token; the egress proxy refuses retriever tokens | No: a read                                 |
| App request (`app_fetch`)                 | Package-app edge           | Direct invocation, streamed; run record written asynchronously                      | No: proposed exception, see Open decisions |
| App realtime                              | Realtime service           | Direct WebSocket invocation                                                         | No: same exception                         |

**Compatibility checks before cutover.** Pin `workerd` to the compatibility date
Kody uses in production. Run the conformance suite: every published package's
exports, jobs, webhooks and apps replayed against staging, with outputs compared
to Cloudflare runs. Any package that fails gets a platform codemod through the
existing `package-codemods/` path, committed but not published.

## Temporal design

Temporal Cloud runs three namespaces that mirror ADR 0016's failure domains. A
bad deploy of the code-execution side cannot stop sign-in, MCP or publishing.

**Namespaces**

| Namespace   | Task queues       | Holds                                                                                                        | Connected by                                                       |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `kody-core` | `app`, `platform` | Web and OAuth mutations, approvals, publish, repo sessions, email, account lifecycle, billing, event fan-out | Nexus endpoint into `kody-exec` for runs                           |
| `kody-exec` | `runtime`         | Every run of user code: `execute`, invocations, jobs, subscriptions, webhooks, package workflows             | Called by the MCP server directly and by `kody-core` through Nexus |
| `kody-ops`  | `ops`             | The 21 maintenance lanes, backups, restore drills, reindexing, migration workflows                           | Reads stores directly; emits admin events into `kody-core`         |

Each namespace starts as a standard namespace (replicated across three
availability zones). A High Availability namespace only helps once Kody's
workers and stores also run in a second region, so it waits for that.

**Workflow catalog**

| Workflow                                          | Queue      | Started by                                                | Workflow id                                                               | Notes                                                                                        |
| ------------------------------------------------- | ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ExecuteRun`                                      | `runtime`  | MCP server, Update-with-Start                             | `{userId}:execute:{requestId}`                                            | Quota check, one sandbox activity, result returned by the Update                             |
| `PackageInvocation`                               | `runtime`  | Front door, event fan-out, broker                         | `{userId}:{surface}:{Idempotency-Key}`, or a random id when none is given | Shared path for HTTP exports, webhooks and subscriptions                                     |
| `JobRun`                                          | `runtime`  | Temporal Schedule `job:{userId}:{jobId}`                  | Schedule-assigned                                                         | Job-scoped scratch bucket, plan interval floor checked when the Schedule is written          |
| `PackageWorkflowRun`                              | `runtime`  | `workflows.create` through the broker                     | `{userId}:wf:{idempotencyKey}`                                            | Durable timer until `runAt`, then one sandbox activity; `concurrent_workflows` checked first |
| `WebhookDelivery`                                 | `app`      | Front door after HMAC and replay checks                   | `{endpointId}:{deliveryId}`                                               | `ack` mode returns 202 after Start; `sync` mode uses Update-with-Start                       |
| `EventFanout`                                     | `platform` | Any producer of a topic event                             | `{topic}:{eventId}`                                                       | One child `PackageInvocation` per subscriber through Nexus                                   |
| `PublishPackage`                                  | `platform` | Repo session publish, git push event, reconcile lane      | `{userId}:publish:{packageId}`                                            | Checks, bundle, reindex, trigger sync; a locked package waits on an approval Signal          |
| `RepoSession` (entity)                            | `platform` | `repoOpenSession`                                         | `{userId}:repo:{sessionId}`                                               | Edits and commits as Updates; idle timer closes it; Continue-As-New keeps history small      |
| `McpServerConnection` (entity)                    | `platform` | Adding a remote MCP server                                | `{userId}:mcp:{serverId}`                                                 | Reconnect and backoff state only; tokens stay in AgentCore Identity                          |
| `InboundEmail`, `OutboundEmail`, `DeliveryEvents` | `platform` | SES events through the event starter; outbound capability | `{userId}:mail:{messageId}`                                               | Auto-pause rule (1 complaint or 5 bounces a UTC day) runs here                               |
| `HumanApproval`                                   | `app`      | Secret host, share, webhook-apply, publish-lock requests  | `{userId}:approve:{requestId}`                                            | Waits on a Signal sent only by the signed-in browser UI                                      |
| `AccountDelete`                                   | `app`      | `POST /account/delete`                                    | `{userId}:delete`                                                         | Saga over every store; user row last, as today                                               |
| Maintenance lanes                                 | `ops`      | One Schedule per lane                                     | `lane:{name}:{fireTime}`                                                  | Continue-As-New for lanes that page through large tables                                     |

**Idempotency with the 90-day contract.** Workflow-id uniqueness stops
duplicates while a run is open or retained. The 90-day replay promise lives in a
DynamoDB table keyed `userId#surface#key`, with a TTL and a pointer to the
stored result. The start path checks it first. Namespace retention can then stay
short (for example 30 days) without breaking the contract.

**Payload encryption.** A payload codec encrypts every payload with AES-GCM data
keys from KMS, with encryption context `{userId, namespace}`. Temporal Cloud
never sees plaintext. A codec server behind IAM Identity Center lets authorised
operators read payloads in the Temporal UI. Search attributes are not encrypted,
so they carry only `stable_user_id`, surface, package id and status, never
emails or names.

**Deploys.** Worker Versioning with one Worker Deployment per pool replaces
`deploy.yml`'s fixed upload order. Short workflows are pinned to the build that
started them. Entity workflows auto-upgrade and use patching.

**Limits designed around.** Payloads stay under about 2 MB and histories under
51,200 events or 50 MB. Entity workflows and paging lanes use Continue-As-New.
The `execute` result cap stays at 100 KB.

**Worker hosting.** All four pools run as ECS Fargate services that scale on
task-queue backlog. Temporal's Serverless Workers on Lambda are a later option
for the `ops` queue, once they leave Public Preview.

## AgentCore usage

Four AgentCore services carry load in v1: Runtime, Code Interpreter, Identity
and Observability. Gateway and Policy are deferred until two compatibility
checks pass. Memory is not used, because it would change what Kody remembers.

| Service          | Used for                                                                                                                      | Why it is the best fit                                                                                                                                                                                                                        | Configuration                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | Kody Runner (HTTP protocol) and the Kody MCP server (MCP protocol)                                                            | A microVM per session, sessions up to 8 hours, a custom container that can hold `workerd`, and session stickiness for the 2025-era MCP lane                                                                                                   | VPC mode, no internet route. Inbound auth is IAM (SigV4) only: callers are Kody's own activities, front door and edges, never the public |
| Code Interpreter | Repo-session workspaces and publish checks                                                                                    | Its file API (read, write, list, run command) maps onto `repoReadFile`, `repoEditFiles`, `repoRunChecks`. A real filesystem replaces the `@cloudflare/shell` emulation (ADR 0020)                                                             | Custom interpreter, VPC mode; reaches only CodeArtifact. Activities copy files in and out, so the session never holds git credentials    |
| Identity         | Credential vault for integration OAuth tokens and remote MCP server tokens; workload identities for the Runner and MCP server | Takes third-party tokens out of Kody's database; only named workloads can fetch them                                                                                                                                                          | Only the egress proxy and the MCP-client activities may call `GetResourceOauth2Token`                                                    |
| Observability    | Traces and metrics for every Runtime and Code Interpreter session                                                             | OpenTelemetry-compatible, lands in CloudWatch beside Temporal's spans                                                                                                                                                                         | Trace context passed from the workflow into the invocation                                                                               |
| Gateway          | Deferred                                                                                                                      | Kody's public MCP needs opaque tokens from existing grants, per-user server instructions and both protocol eras, all unverified on Gateway. Remote MCP servers are added by users at runtime; Gateway targets are configured per gateway      | Revisit when the stateless `2026-07-28` lane is the only lane                                                                            |
| Policy           | Deferred with Gateway                                                                                                         | Attaches to Gateway tool calls                                                                                                                                                                                                                | Kody's fresh-per-request RBAC stays the gate                                                                                             |
| Memory           | Not used                                                                                                                      | Kody writes memories deliberately (`metaMemoryVerify` first), collapses by `dedupe_key` and soft-deletes. Long-term extraction would change behaviour, and `search` needs one index across memories, capabilities, packages and guides anyway | Memories stay in Aurora with pgvector                                                                                                    |
| Browser          | Not used                                                                                                                      | Kody has no browsing surface                                                                                                                                                                                                                  | —                                                                                                                                        |

**How the MCP server sits on Runtime.** The front door stays the single `/mcp`
chokepoint, as `mcp-auth.ts` is today. It validates the bearer token, rejects
unverified or suspended accounts, and then invokes the MCP server runtime. The
`runtimeSessionId` is derived from `Mcp-Session-Id` for the 2025 lane and is per
request for the stateless lane. The user context travels in a header signed by
the front door. Connected hosts keep the same `https://kody.codes/mcp` URL and
the same tokens.

## Key request flows

Reads never touch Temporal; every write does, including quota counters. The
seven flows below cover the main entry points; package-app requests are covered
under Package runtime.

**1. Signed-in page (read), then a form submit (write)**

1. CloudFront passes the request to the front door. It checks the canonical host
   and the cookie signature, and rejects a cookie issued at or before
   `password_changed_at`.
2. One query batch on the Aurora reader loads the user row and roles; feature
   flags evaluate in parallel. Remix renders on the server, with Shiki
   highlighting in-process.
3. A form submit becomes Update-with-Start on `app`. An activity writes Aurora
   in one transaction and the Update returns the result.
4. After a write, the front door sets a short-lived flag so the next read uses
   the Aurora writer endpoint. The user never sees their own change missing
   because of replica lag.

**2. MCP `search` (read)**

1. The front door authenticates the bearer token and invokes the MCP server on
   AgentCore Runtime.
2. The server ranks capabilities, packages, guides and memories with pgvector
   plus Postgres full-text on the Aurora reader, then reranks, as
   `search-scoring.ts` does today.
3. Retrievers run in the user's Runner session with a read-only token that the
   egress proxy refuses.
4. The only writes (new `conversationId`, memory suppressions) are
   fire-and-forget workflow Starts.

**3. MCP `execute` (write)**

1. The MCP server calls Update-with-Start for `ExecuteRun` in `kody-exec`.
2. An activity consumes `execute_calls_per_day` with a DynamoDB conditional
   update and fails closed if the quota is spent.
3. An activity mints a run token (user, run id, provenance stamps, expiry) and
   invokes the user's Runner session. It heartbeats until the 90-second
   deadline.
4. Inside the Runner, `kody.*` calls go to the broker and every `fetch` goes to
   the egress proxy.
5. The result is written to the runs table and S3 logs. The Update returns it to
   the MCP server, capped at 100 KB with the same `Server-Timing` phases.

**4. Inbound webhook**

1. The front door looks up the endpoint by URL secret, then checks the HMAC
   signature and replay window (reads).
2. Update-with-Start on `WebhookDelivery` (id `{endpointId}:{deliveryId}`). The
   Update handler admits or rejects the delivery against the per-endpoint rate
   limit, so a 429 still comes back immediately.
3. In `ack` mode the Update returns 202 once admitted; in `sync` mode it waits
   for the result.
4. The workflow runs `PackageInvocation` in `kody-exec` through Nexus. A
   duplicate delivery id attaches to the same workflow instead of running twice.

**5. Scheduled job**

1. The Temporal Schedule for the job starts `JobRun`.
2. An activity consumes `job_runs_per_day`, then the run goes to the Runner with
   a job-scoped scratch bucket.
3. A failure records the run and emits `run.error.recorded` into `EventFanout`,
   so subscribed packages react as today.

**6. Publish a package**

1. A repo-session publish, or a push to CodeCommit (through EventBridge and the
   event starter), starts `PublishPackage`.
2. An activity checks out the commit and copies it into a Code Interpreter
   session, which runs manifest, bundle, typecheck, lint and docs checks.
3. A locked package starts `HumanApproval` and waits for the owner's click in
   the browser.
4. Activities write bundles to S3 keyed by commit, reindex with Bedrock
   embeddings, and sync Schedules, webhooks and subscriptions.
   `published_commit` advances last.

**7. Inbound email**

1. An SES receipt rule stores the raw MIME in S3 and emits an event. The event
   starter begins `InboundEmail`.
2. The workflow resolves the username (plus-address tag kept), rejects unknown,
   unverified or suspended owners, and applies sender rules and the SES DMARC,
   SPF and DKIM verdicts.
3. It stores the parsed message in Aurora and fans out `email.message.received`
   or `email.message.quarantined`.

## Data architecture

State moves into six AWS stores: Aurora PostgreSQL, DynamoDB, S3, the SQLite
storage cells, CodeCommit and AgentCore Identity. Every frozen key string in
`data-storage.md` is kept byte for byte; only the product under it changes.

| Data                            | Today                                      | Target                                                                          | Key and isolation                                                                                                                                                          |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application tables (about 100)  | D1 `APP_DB`                                | Aurora PostgreSQL app cluster                                                   | Row-level security on `user_id`; workers set `app.user_id` per transaction. Only activities and the broker use the writer; the front door and MCP server use a reader role |
| Audit trail                     | D1 `AUDIT_DB`                              | Separate Aurora cluster, daily export to S3 with Object Lock                    | Append-only role; outside the app cluster's blast radius                                                                                                                   |
| Job definitions                 | D1 `JOBS_DB`                               | Temporal Schedules plus job config rows in Aurora                               | Schedule id `job:{userId}:{jobId}`                                                                                                                                         |
| Package storage                 | `StorageRunner` SQLite                     | Storage cells: one SQLite file per bucket                                       | Same `[userId, storageId]` id; replica at `storage/{userId}/{storageId}` in S3                                                                                             |
| Quotas and storage bytes        | `UserMeter`                                | DynamoDB `meters`                                                               | Partition key `userId`, sort key `counter#day`; conditional atomic updates                                                                                                 |
| OAuth clients, grants, tokens   | `OAUTH_KV`                                 | DynamoDB `oauth` with TTL                                                       | The library's KV key strings become the item keys unchanged                                                                                                                |
| Idempotency ledger              | `RunLog`                                   | DynamoDB `idempotency`, 90-day TTL                                              | `userId` + `surface#key`                                                                                                                                                   |
| Run history and logs            | `RunLog`                                   | DynamoDB `runs` (90-day TTL) plus log files in S3                               | `userId` + `startedAt#runId`; logs under `runs/{userId}/`                                                                                                                  |
| Published bundles and snapshots | `BUNDLE_ARTIFACTS_KV`                      | S3, immutable, plus a DynamoDB index                                            | The KV key string becomes the S3 object key                                                                                                                                |
| Source repos                    | Cloudflare Artifacts                       | CodeCommit, one repo per repo or package                                        | `entity_sources` stores the repo ARN                                                                                                                                       |
| Mail                            | `Mailbox` Durable Object, R2 `EMAIL_BLOBS` | Aurora for messages and the delivery ledger; S3 for raw MIME and attachments    | Same R2 object keys reused in S3                                                                                                                                           |
| Remote MCP servers              | `McpClientHub`                             | Aurora registrations; tokens in AgentCore Identity                              | Token access limited to MCP-client activities                                                                                                                              |
| Repo-session workspaces         | `RepoSession`, R2 spill                    | Code Interpreter session, `RepoSession` workflow, S3 spill; catalog in DynamoDB | Session id plus owner check on every call, as today                                                                                                                        |
| Vectors                         | Vectorize, per-user namespaces             | pgvector tables in Aurora                                                       | `user_id` column plus row-level security; built-ins under `__kody_builtin__`. Derived, rebuilt from Aurora, never backed up                                                |
| Secrets                         | D1 `secret_entries`                        | Aurora, KMS envelope ciphertext                                                 | Encryption context `{userId}` replaces AAD `user:<userId>`                                                                                                                 |
| Community assets                | R2 `COMMUNITY_ASSETS`                      | S3 behind CloudFront                                                            | Public by design                                                                                                                                                           |
| Realtime app state              | `PackageRealtimeSession`                   | DynamoDB                                                                        | `{userId, packageId}`                                                                                                                                                      |
| Product analytics               | 8 Analytics Engine datasets                | Firehose to S3 (Parquet), queried with Athena                                   | One prefix per dataset                                                                                                                                                     |

**Storage cells keep `sql()` unchanged.** A cell is an ECS task on EC2 with an
EBS volume. It owns a set of buckets by consistent hash on the storage id.
Ownership is a lease with a fencing token in DynamoDB, so only one cell ever
writes a bucket, matching Durable Object semantics. Litestream streams each
database's changes to S3 continuously. If a cell dies, another takes the lease
and restores from S3. The broker is the only caller; it reserves `storage_bytes`
in DynamoDB before a write, and the 1,000-row cap stays.

**Keeping isolation structural.** Workers never hold broad data credentials for
a run. They assume a role tagged with the run's `userId` (credentials cached per
user for minutes). Attribute-based conditions (`dynamodb:LeadingKeys` against
the principal tag, S3 prefix conditions) stop them touching another user's
items. Aurora row-level security does the same for SQL. Cross-user access exists
only in the four documented exceptions, each behind its own admin role.

**Frozen contracts.** Every entry in `data-storage.md` (D1 JSON columns, Durable
Object ids, KV keys, R2 keys, Vectorize metadata) gets a row in a mapping table:
old format, new home, identical string or explicit rewrite. The conformance
suite reads each through the new stores before cutover.

## Identity, OAuth and secrets

Kody keeps its own user identity and OAuth 2.1 server, so every existing login,
cookie and MCP grant keeps working. AWS KMS takes over the keys. AgentCore
Identity takes over third-party tokens.

| Concern                                                       | Target                                                                                                                               | How existing users carry over                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User identity                                                 | `stable_user_id` unchanged; `users` table in Aurora                                                                                  | Nothing changes for users; every key built on it stays valid                                                                                                                                                  |
| Browser sessions                                              | `kody_session` cookie; signing secret in Secrets Manager, read by the front door                                                     | Same `COOKIE_SECRET` value, so existing cookies stay valid                                                                                                                                                    |
| Sign-in methods                                               | Kody's password, TOTP, passkey and GitHub, Google, X, Discord handlers; reads in the front door, writes as `app` activities          | Same password hashes, passkeys and linked accounts. Cognito is not used: Kody's handlers already cover CIMD, dynamic registration, X and Discord, which Cognito is not verified to support                    |
| OAuth 2.1 server for MCP hosts and CLI                        | Kody's `workers-oauth-provider` logic with a DynamoDB storage adapter; CIMD, dynamic registration and refresh-family reuse unchanged | Grants copied from `OAUTH_KV` with identical keys; hosts keep their refresh tokens                                                                                                                            |
| OIDC ID tokens                                                | Signed by an asymmetric KMS key; the private key never leaves KMS                                                                    | JWKS publishes the old and new keys for an overlap period, then the old one is dropped                                                                                                                        |
| Revocation                                                    | Epoch fence on `password_changed_at`, checked at every chokepoint                                                                    | Same rule                                                                                                                                                                                                     |
| User and package secrets                                      | KMS envelope encryption, context `{userId}`, ciphertext in Aurora                                                                    | A one-time `ops` workflow decrypts with `SECRET_STORE_KEY` and re-encrypts; the old key is then destroyed                                                                                                     |
| Integration tokens                                            | AgentCore Identity token vault                                                                                                       | Gate: confirm existing refresh tokens can be loaded into the vault. If not, migrated connections stay KMS-encrypted in Aurora and move on the user's next reconnect; new connections go straight to the vault |
| Remote MCP server tokens                                      | AgentCore Identity token vault                                                                                                       | Same gate and fallback                                                                                                                                                                                        |
| Approvals (secret hosts, shares, webhook apply, publish lock) | `HumanApproval` workflow; the Signal comes only from the signed-in browser                                                           | An agent can still request but never approve                                                                                                                                                                  |
| RBAC                                                          | Same tables and permission strings in Aurora, loaded fresh per request                                                               | Unchanged                                                                                                                                                                                                     |
| Credential rate limits                                        | AWS WAF rate-based rules on auth paths                                                                                               | Replaces `AUTH_RATE_LIMITER`                                                                                                                                                                                  |
| Operator access                                               | IAM Identity Center for AWS consoles, the Temporal codec server and DR tools                                                         | Replaces Cloudflare Access                                                                                                                                                                                    |

**The egress proxy, step by step.** It is the only principal that can decrypt a
secret or fetch a third-party token.

1. Verify the run token and its expiry; retriever tokens are refused.
2. Consume `outbound_fetches_per_day` in DynamoDB; fail closed if spent.
3. Resolve `{{secret:…}}`, `{{integration-token:…}}` and secret-provider
   placeholders in the final serialized request only.
4. Check the host against the user's approved allowlist and the integration's
   `required_hosts`; block Kody's own hostnames.
5. Send through a NAT gateway with fixed Elastic IPs, under the per-fetch
   timeout, and stream the response back.

Fixed egress IPs are a side benefit: customers can allowlist Kody's outbound
traffic, which Cloudflare's shared egress could not offer.

## Network and security

One VPC across three availability zones, with sandbox subnets that have no route
to the internet. Everything else reaches AWS services and Temporal Cloud through
private endpoints.

| Subnet tier | Holds                                                                            | Outbound route                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public      | ALBs for the front door and app edge; NAT gateways                               | Internet                                                                                                                                                   |
| Private app | Front door, app edge, MCP server runtime, worker pools, broker, realtime service | VPC endpoints; Temporal Cloud over PrivateLink; trusted platform calls (Stripe, OAuth providers) through NAT with an AWS Network Firewall domain allowlist |
| Sandbox     | Kody Runner and Code Interpreter network interfaces                              | None. Security groups allow only the broker, the egress proxy, the S3 gateway endpoint and CodeArtifact (check sessions only)                              |
| Egress      | Egress proxy                                                                     | NAT with fixed Elastic IPs; the only path for user-code traffic and user-added remote MCP servers                                                          |
| Data        | Aurora clusters, storage cells                                                   | None                                                                                                                                                       |

**Controls that close known gaps**

- **DNS exfiltration.** Route 53 Resolver DNS Firewall on sandbox subnets
  resolves only the broker, proxy and S3 names. This addresses the published DNS
  bypass of Code Interpreter's Sandbox mode; neither sandbox uses Sandbox or
  Public network mode.
- **SSRF.** The egress proxy blocks private ranges, the instance metadata
  address and every Kody hostname before connecting.
- **Cookie separation.** `kody.run` stays a separate registrable domain from
  `kody.codes` (ADR 0017), so package code can never read app cookies.
- **Private endpoints.** S3 and DynamoDB gateway endpoints; interface endpoints
  for KMS, Secrets Manager, STS, CloudWatch Logs, ECR, Bedrock runtime,
  AgentCore, SES, CodeCommit and CodeArtifact.
- **Edge.** AWS WAF managed rules plus rate rules on CloudFront; Shield
  Standard.

**AWS accounts** (AWS Organizations): production, staging and per-PR preview,
shared services (CI, ECR, CodeArtifact), backup (AWS Backup vault lock, S3
Object Lock) and log archive. Production data never shares an account with CI.

## Observability, metering and billing

One OpenTelemetry trace now runs from the MCP call to the sandbox and out
through the egress proxy. Billing units must change, because Dynamic Worker days
and Durable Object rows no longer exist.

| Layer                    | Target                                                                                                                                            | Who reads it                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Run records (9 surfaces) | DynamoDB `runs` table with status, timings and truncated error; up to 200 log lines in S3                                                         | Users at `/account/activity` and `runs` capabilities. Users never read Temporal directly |
| Workflow state           | Temporal Visibility with search attributes `userId`, `surface`, `packageId`, `status`                                                             | Operators, through the Temporal UI and codec server                                      |
| Traces                   | OpenTelemetry from the front door, MCP server, Temporal interceptors, AgentCore Observability, broker and egress proxy, into CloudWatch and X-Ray | Operators. Supersedes ADR 0008                                                           |
| Logs and errors          | CloudWatch Logs with metric filters and alarms                                                                                                    | Operators                                                                                |
| Quotas                   | DynamoDB `meters`                                                                                                                                 | Enforcement and `/account/usage`                                                         |
| Usage and product events | Firehose to S3, queried with Athena                                                                                                               | Admin insights, credit debits                                                            |
| Audit                    | Aurora audit cluster plus CloudTrail (every KMS decrypt and Identity token fetch, tagged by user)                                                 | Admins, security review                                                                  |
| Status                   | CloudWatch Synthetics probing the public endpoints, page on S3 and CloudFront                                                                     | Public, still up if Temporal is down                                                     |

**Alerting keeps Kody's pattern.** Alert lanes still emit admin-only events that
operator packages subscribe to (ADR 0041). Infrastructure alarms that packages
cannot see (Temporal unreachable, Aurora failover, Runner session errors) page
through CloudWatch alarms and SNS.

**Operator levers that did not exist before:** Workflow Pause, Activity
Operations, reset, batch terminate and per-run history.

**Billing re-base (needs a product decision).** Credits under ADR 0051 debit
Dynamic Worker days and Durable Object rows read. The proposed new meters follow
real cost: sandbox compute (vCPU-seconds and memory-seconds, measured per
invocation by the Runner supervisor and reconciled with AgentCore billing),
storage-cell operations, and outbound bytes. Plan limits keep their names where
possible; the monthly Dynamic Worker day becomes a sandbox compute-second
allowance.

## Migration and cutover

Kody moves in one rehearsed cutover, not a long dual run. The platform had 172
accounts at the 1 Sep 2026 launch audit. Split state across two platforms would
cost more risk than a short maintenance window. Every store is copied and
checked in rehearsal first.

**Phases and their gates**

1. **Foundations.** AWS accounts, VPC, KMS keys, Temporal Cloud namespaces with
   PrivateLink, CI pipelines. Gate: the conformance harness can replay a
   published package end to end.
2. **Runtime.** Kody Runner (`workerd` on AgentCore Runtime), broker, egress
   proxy, storage cells. Gate: every published package passes the conformance
   suite on staging, or has a committed codemod.
3. **Platform.** Aurora schema and queries ported from D1, activities and
   workflows, front door, MCP server on Runtime, OAuth DynamoDB adapter, SES.
   Gate: Playwright, MCP end-to-end and workers test suites green on staging.
4. **Data rehearsal.** A full copy of a production snapshot into staging,
   repeated until clean. Gate: row counts and checksums match for every store,
   and the cutover window is timed.
5. **Cutover.** Details below. Gate: health checks, the `execute` smoke and the
   status probes pass on AWS.
6. **Decommission.** Cloudflare stays read-only for a short rollback window,
   then is removed and `SECRET_STORE_KEY` is destroyed.

**What each store needs during the copy**

| Source                                                                          | Destination                                                | Method                                                             |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| D1 `APP_DB`, `AUDIT_DB`                                                         | Aurora                                                     | Export, type-map SQLite to PostgreSQL, load, checksum per table    |
| `JOBS_DB`                                                                       | Temporal Schedules (created paused) plus Aurora rows       | `ops` migration workflow                                           |
| `OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`                                               | DynamoDB, S3                                               | Key-for-key copy                                                   |
| R2 buckets                                                                      | S3                                                         | Object copy with the same keys                                     |
| Cloudflare Artifacts repos                                                      | CodeCommit                                                 | Mirror clone and push per repo                                     |
| `StorageRunner` buckets                                                         | Storage cells                                              | The existing paged export, written into one SQLite file per bucket |
| `Mailbox`, `RunLog` (last 90 days of idempotency), `McpClientHub` registrations | Aurora, DynamoDB                                           | Per-user export through the existing account-export paths          |
| Secrets                                                                         | Aurora with KMS                                            | Decrypt and re-encrypt in a sealed `ops` workflow                  |
| Integration and MCP tokens                                                      | AgentCore Identity, or KMS store if import is not possible | See Identity                                                       |
| Vectors                                                                         | pgvector                                                   | Rebuilt with Bedrock embeddings, not copied                        |

**Cutover sequence**

1. Lower DNS TTLs days ahead; Route 53 becomes authoritative with records still
   pointing at Cloudflare.
2. Put Cloudflare into edge maintenance mode (the script already exists).
   Webhook senders retry during the window.
3. Run the final delta copy and checksums.
4. Switch DNS for `kody.codes`, `*.kody.run` and `status.kody.codes`, and the MX
   record for `inbox.kody.codes`.
5. Unpause Temporal Schedules and run the smoke checks.

**Rollback.** Before the first write lands on AWS, rollback is lifting
maintenance mode on Cloudflare. After that, fix forward, which matches Path B in
Kody's existing rollback runbook.

## Build, deploy and environments

The Nx monorepo and `npm run validate` stay the single gate. AWS CDK in
TypeScript replaces the Wrangler configs and `tools/ci/*-resources.ts`.

- **New workspace packages:** `front-door`, `app-edge`, `mcp-server`, `runner`
  (container image with `workerd` and the supervisor), `broker`, `egress-proxy`,
  `storage-cell`, `realtime`, one worker package per task queue, and `infra`
  (CDK).
- **CI:** GitHub Actions with OIDC federation into AWS. Images go to ECR in the
  shared-services account. The Nx remote cache moves from R2 to S3.
- **Deploys:** every service and worker pool deploys on its own. Forward-only
  Aurora migrations run as an `ops` workflow before dependent services. ECS
  services use blue/green. Temporal pools ramp with Worker Versioning. AgentCore
  runtimes publish a new version and move the endpoint to it; rollback moves the
  endpoint back.
- **Environments:** production, staging, and per-PR preview. Previews share one
  Temporal Cloud namespace with task queues prefixed by PR number.
- **Local development:** Temporal dev server plus Docker Compose (PostgreSQL
  with pgvector, LocalStack for S3 and DynamoDB). The Runner container runs
  locally as-is, because `workerd` does not need AgentCore to run.
- **New checks in `validate`:** the package conformance suite, CDK synth diff,
  and the frozen-key mapping test.

## Decision records changed

Six records are superseded, three are amended, and six new ones are needed. The
rest stay as written, including every package and auth rule that packages depend
on.

| Record                                                               | Status     | Why                                                                                                                                                 |
| -------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0002 data placement                                                  | Superseded | New rubric: Aurora for relational data, DynamoDB for per-user hot state, S3 for blobs, storage cells for package SQLite, Temporal for durable state |
| 0008 no span-level tracing                                           | Superseded | OpenTelemetry end to end comes with Temporal and AgentCore                                                                                          |
| 0020 shell-based repo sessions                                       | Superseded | Code Interpreter sessions give a real filesystem                                                                                                    |
| 0034 origin owns no Durable Objects                                  | Superseded | No Durable Objects remain; the principle lives on as rule 1                                                                                         |
| 0047 Vectorize per-user namespaces                                   | Superseded | pgvector with row-level security has no namespace cap                                                                                               |
| 0051 credit units                                                    | Superseded | New meters (see Observability)                                                                                                                      |
| 0016 failure-domain split                                            | Amended    | Enforced by three Temporal namespaces and Nexus instead of Worker scripts                                                                           |
| 0005 dual MCP lanes                                                  | Amended    | Both lanes on one MCP server runtime; stateless-only remains the plan                                                                               |
| 0019, 0038–0040 Nx cache                                             | Amended    | Cache backed by S3                                                                                                                                  |
| 0025 no long-running services                                        | To revisit | 8-hour Runtime sessions make package services possible; not needed for this migration                                                               |
| 0001, 0003, 0021, 0033, 0035–0037, 0042, 0046, 0049, 0050 and others | Kept       | Package, composition, auth and catalog rules are part of the compatibility contract                                                                 |

**New records to write**

- Temporal is the only durable-execution layer; user code never runs as workflow
  code.
- Reads are direct; writes go through Temporal.
- The package runtime is `workerd` inside AgentCore Runtime, one session per
  user.
- The egress proxy is the only principal that can resolve a secret or
  third-party token.
- Package storage runs on SQLite storage cells with single-owner leases.
- AgentCore Gateway, Policy and Memory are deferred, with the conditions that
  would bring them in.

## Risks and items to verify

The design rests on four unverified capabilities: Worker Loader in open-source
`workerd`, Runner session latency, AgentCore quotas and token import into
Identity. Each needs a spike in phase 1, and each has a fallback that keeps the
design intact.

| #   | Item                                                                              | Why it matters                                            | How to verify                                                | Fallback                                                                                                            |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Worker Loader in open-source `workerd` behaves as in production                   | The Runner reuses `executor.ts` unchanged only if it does | Run the conformance suite in the Runner container locally    | One `workerd` process per module graph inside the session                                                           |
| 2   | Runner cold start and invoke latency                                              | `execute` feel; retrievers have 1–3 s budgets             | Measure p50 and p95 for warm and cold sessions               | Pre-warm the user's session when an MCP session opens; take retrievers out of `context` scope if budgets still miss |
| 3   | Parallel invocations into one Runtime session                                     | A user can run several agents at once                     | Load test one session                                        | A small pool of sessions per user                                                                                   |
| 4   | AgentCore quotas: concurrent sessions, session creation rate                      | One session per active user                               | Service quotas page plus a quota-increase request            | Spread across accounts                                                                                              |
| 5   | Custom Code Interpreter can run esbuild and `tsc` with CodeArtifact access        | Publish checks                                            | Spike in VPC mode                                            | Run checks in a second Runtime container image                                                                      |
| 6   | Existing refresh tokens can be loaded into AgentCore Identity                     | Integrations keep working without reconnects              | API test with a sandbox provider                             | KMS store for migrated connections (Identity section)                                                               |
| 7   | MCP runtime accepts the signed user-context header and keeps 2025-lane stickiness | The front door stays the chokepoint                       | Spike with both protocol eras                                | Run the MCP server on ECS; keep AgentCore for the Runner                                                            |
| 8   | Update-with-Start latency on web writes and `execute`                             | Every write goes through Temporal                         | Measure p50 and p95 over PrivateLink                         | Keep write workflows to one activity; eager start where supported                                                   |
| 9   | Temporal Schedule counts and monthly actions                                      | One Schedule per package job; cost                        | Model from current job and run volumes                       | Coalesce low-frequency jobs per user                                                                                |
| 10  | CodeCommit repositories per account                                               | One repo per package                                      | Service quotas                                               | Quota increase or a second account                                                                                  |
| 11  | Storage cells are a new stateful system to run                                    | Package data durability                                   | Restore drills and lease-fencing tests before cutover        | None needed if drills pass; this is the biggest build item                                                          |
| 12  | D1 to PostgreSQL port of about 100 tables and 71 migrations                       | Platform correctness                                      | Existing test pools against Aurora                           | None; it is a required port                                                                                         |
| 13  | Bedrock embedding quality compared with Workers AI                                | Search relevance                                          | Replay recorded search queries from `kody_mcp_search_events` | Try a second Bedrock embedding model                                                                                |
| 14  | FSL-1.1-ALv2 terms for this fork                                                  | How the result may be offered                             | Legal review (not legal advice here)                         | —                                                                                                                   |

## Open decisions

Five decisions remain open; the rest of the design does not change whichever way
they go.

- [ ] **Package-app requests outside Temporal.** Proposed: app requests,
      realtime and retrievers go straight to the Runner, because a page load
      through a workflow adds latency and cost to every click. Writes they make
      still pass through the broker and are recorded. The alternative is strict
      routing through Temporal.
- [ ] **Billing units.** Approve the proposed meters (sandbox compute-seconds,
      storage-cell operations, outbound bytes) or name others.
- [ ] **Integration token fallback.** If AgentCore Identity cannot import
      existing tokens: keep migrated tokens KMS-encrypted until each user
      reconnects (proposed), or ask every user to reconnect at cutover.
- [ ] **Cutover downtime.** Is a maintenance window acceptable? Its length comes
      from the phase 4 rehearsal.
- [ ] **Region.** Pick the primary AWS region, subject to AgentCore Runtime,
      Code Interpreter, Identity and Temporal Cloud PrivateLink availability.
