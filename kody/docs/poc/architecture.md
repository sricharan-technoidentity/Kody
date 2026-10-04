# Local POC architecture

The two-package workspace is retained: `packages/worker` owns the Node app,
Temporal workflows/activities and AWS ports; `packages/shared` owns portable
contracts. Vite serves Remix development modules. Native workerd runs published
package graphs with the existing runtime API, a signed capability broker and
restricted egress. Temporal owns durable mutations and scheduled work.

| Component                   | Local demo                                                   | Live proof / remaining work                              |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Front door / MCP / UI       | Real Node HTTP, OAuth, two tools, Vite/Remix                 | No cloud front door deployed by this work                |
| Orchestration               | Real Temporal development server; four queues, one namespace | Cloud namespaces, Nexus, TLS and durable stores deferred |
| Relational / search         | PGlite, real PostgreSQL schema/RLS, pgvector                 | Existing PostgreSQL/Aurora proof only                    |
| Package execution           | Native workerd, unchanged module graphs                      | Compatible existing AgentCore Runtime proof only         |
| Package storage             | SQLite files with fenced leases                              | Cell service deployment deferred                         |
| Quotas / keyed records      | Explicit in-memory DynamoDB fakes                            | Existing DynamoDB tables proof only                      |
| Bundles / logs / mail blobs | Explicit in-memory S3 fakes                                  | Existing S3 bucket proof only                            |
| Secret envelopes            | Context-enforcing fake KMS                                   | Existing KMS key proof only                              |
| Source repository / checks  | Local repository fixture, fake interpreter                   | Code Interpreter proof; CodeCommit/CodeArtifact deferred |
| Remote connector Identity   | Imported-token vault fake                                    | Existing authorized provider/user required               |
| Embeddings                  | Deterministic local embedding                                | Existing Bedrock model proof only                        |
| Email                       | In-memory SES outbox                                         | SES mailbox simulator proof only                         |

State belongs to one launcher session. Worker restart keeps Temporal, PGlite,
object/record fakes and SQLite cells alive. Complete reset recreates only that
session. No real credentials are needed. Legacy binding names and object keys
remain where compatibility requires them; the exact reference allowlist explains
retained references. Archived Workers fixtures are excluded from POC evidence.
Realtime delivery, cloud networking, telemetry, backups and production billing
remain future work. Local checks and individual AWS service proofs cannot
establish production migration readiness.
