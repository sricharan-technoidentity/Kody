# POC limitations inventory

Local readiness is separate from live AWS verification. Historical P0–P8
shortcut comments and counts are in
[the dated archive](../audits/migration-2026-10-04/index.md). The active
limitations are:

| Component              | Implemented local proof                                                    | Remaining limit                                                                           |
| ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Node front door        | Existing app/OAuth/MCP handlers, scoped PostgreSQL, Temporal mutations     | Cloud deployment/networking and streaming mutation bodies                                 |
| Temporal               | Real server/workers, Schedules, timers, payload codec, restart             | One local namespace; plaintext gRPC; Cloud mTLS/API-key and Nexus split                   |
| SQL/search             | PGlite, real schema/RLS/roles and pgvector                                 | Aurora connections/schema/grants need explicit live proof; no production data copy        |
| Record/object services | Production adapters over injected fakes                                    | DynamoDB/S3 live IAM, TTL, capacity and durability unverified                             |
| Package Runner         | Native workerd, broker, egress, unchanged graphs; HTTP host artifact       | ARM64 container build/deployed Runtime compatibility requires external builder/deployment |
| Broker                 | Signed owner/run/provenance, internal graph authorization                  | Registrations are process-local and cannot survive host restart                           |
| Storage                | SQLite, fencing, quotas and row caps                                       | Persistent cell service deployment/backup/lease behavior across hosts                     |
| Source/checks          | Actual local Git fixture, publish/bundle path                              | REST source metadata and interpreter results simulated; CodeCommit/CodeArtifact deferred  |
| Identity/MCP clients   | Owner/versioned SQL catalog, ephemeral SDK compatibility cache, fake vault | Consent/provisioning bridge and distributed owner operation coordination                  |
| Embeddings             | Deterministic 1024-dimensional local model, actual vector query            | Real Bedrock inference and vector search require both model and PostgreSQL proofs         |
| Email                  | SES port, synthetic local outbox, Temporal events                          | Real routing/delivery, provider events and SES limits; optional mailbox simulator proof   |
| Realtime               | Preserved session metadata and API                                         | WebSocket transport and package hook delivery                                             |
| Telemetry/billing      | Existing instrumentation and usage contracts                               | Collector pipelines, measured cloud billing, capacity, backups and recovery               |

DynamoDB KV values retain their ~390 KB ceiling. Some list/retention operations
scan an owner partition or fleet and require capacity work at scale. S3 adapters
buffer objects and the app Runner buffers responses. Active adapters and key
strings remain preserved; no local gate establishes production migration
readiness. Use [fresh evidence](../poc/readiness.md) and
[individual AWS statuses](../poc/aws-evidence.json).
