# Request lifecycle

The Node front door adapts Web Request/Response handlers without changing the
published application or MCP routes. `front-door/server.ts` binds loopback in
the local POC, preserves repeated cookies and binary bodies, and handles
disconnects. Vite supplies development modules; the client/SSR build supplies
deployable assets.

`front-door/env.ts` resolves signed cookies or OAuth grants to a stable account
ID. Each request receives explicit PostgreSQL roles and owner scope. Ordinary
GET/HEAD reads use the reader. Mutating HTTP handlers, OAuth flows and
package-app execution run through `FrontDoorMutation` on the `app` queue, with
one activity attempt because existing handlers can have uncertain effects. A
signed read-after-write cookie routes the next read to the writer-backed reader.
Admin pages use the operator role only after account roles authorize the
request.

Webhook ingress resolves public username metadata, then reads endpoint/package
state through that owner's PostgreSQL scope. The URL secret is checked before
any private delivery result is exposed. Signed-out callers do not receive
general cross-user database access. Inbound routes preserve their existing
grants, hashes and published URL contracts.

MCP keeps the two-tool surface `search` / `execute`, with OAuth bearer
authentication and the existing capability catalog. Existing OAuth-provider and
workerd API shapes remain compatibility dependencies. Search uses
PostgreSQL/pgvector; local embeddings are deterministic fakes. Execute and
published package apps load unchanged module graphs into native workerd. Signed
run provenance controls broker capabilities and storage; outbound fetch uses the
restricted egress proxy and host-side secret/token resolution. Sandbox code
receives neither database nor AWS credentials.

Temporal workflows own orchestration and durable timers. The local namespace is
`default`; queues are `app`, `exec`, `events`, and `maintenance`. KMS payload
codecs run with a context-enforcing fake key service locally. Workers can
restart while the Temporal server and stores remain available. Full reset
recreates the whole local session and does not demonstrate cloud persistence.

Run state uses DynamoDB adapters, logs/results use object adapters, and package
storage uses fenced SQLite cells. Local instances inject explicit in-memory AWS
fakes beside real PGlite schema/RLS and pgvector. SES sends enter a synthetic
outbox; source REST/check/Identity services are simulated. See
[the current matrix](../../poc/architecture.md), [demo](../../poc/demo.md), and
[readiness evidence](../../poc/readiness.md).

The historical Workers request topology, edge caching and telemetry setup are in
[the audit archive](../../audits/migration-2026-10-04/index.md). Cloud
networking, streaming mutation payloads, distributed broker registrations and
collector setup remain outside local readiness.
