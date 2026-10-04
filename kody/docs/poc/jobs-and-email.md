# Jobs, package runtime and email

Package manifests keep their existing jobs, callable exports, webhooks and event
subscriptions. PostgreSQL stores package-owned job configuration. Temporal
Schedules use the `job:<userId>:<jobId>` ID contract, reflect enabled state, and
fire `JobRun` on the execution queue. Schedule upserts replace configuration
rather than creating duplicates; owner removal cannot affect another account. A
10-minute catch-up window is a POC limit. The local walkthrough uses a one-time
schedule.

Native workerd executes the existing module graph and `kody:runtime` API. Static
import provenance governs package storage and stamp-aligned secret authority.
Storage cells use SQLite files, lease fencing, quota reservation and row caps.
The only network services available to the sandbox are the signed capability
broker and restricted egress proxy. Broker callbacks are process-local for the
lifetime of a run; distributed hosting is deferred.

Temporal timers let inline/package workflows outlive MCP requests. The presenter
injects one controlled failure before execution and verifies a single stored row
after retry. Existing HTTP mutations, execute, jobs and outbound-email effects
retain single-attempt behavior; their uncertain effects must not be replayed
merely to demonstrate retries. Restarting workers preserves the server and
stores; full reset recreates the whole local session.

Email provider ports use SES, delivery events use Temporal, blobs use object
storage and mailbox metadata uses PostgreSQL. User inboxes remain owner-scoped;
reserved system mail is operator-owned. Local sends append to an in-memory
outbox and cannot prove routing, deliverability, account limits or provider
webhooks. The optional SES proof sends only to the mailbox simulator. Inbound
transport and cloud storage/network wiring require separate deployment work.

[Architecture](./architecture.md), [presenter flow](./demo.md),
[service proofs](./aws.md), and [readiness evidence](./readiness.md) explain the
local versus live boundaries. Original SQL migrations, grants, package behavior
and published URL contracts remain compatibility obligations.
