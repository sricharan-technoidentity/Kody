# Temporal + AgentCore migration overview

P0–P8 are recorded complete for the isolated migration POC. Production
migration, data copy, infrastructure provisioning, deployment and cutover remain
deferred. The next work is the
[demo readiness plan](./poc-demo-readiness-plan.md).

## Accepted compatibility decisions

Amendment (2026-10-05): the
[package execution replacement plan](./package-execution-aws-temporal-plan.md)
supersedes the workerd decision with Deno sandboxes and an esbuild/TypeScript
toolchain. The local default uses Deno after retained compatibility and native
comparison checks; workerd/worker-bundler execution dependencies are retired. No
production switch or package republishing is authorized by this amendment. See
[replacement evidence](../docs/poc/package-execution.md) for local checks and
the separately pending live AWS proofs.

Keep the two-package workspace, owner isolation, existing package behavior,
published URLs and grants, and the MCP `search` / `execute` surface. Run
published module graphs in fresh Deno sandboxes behind the authenticated
capability broker and restricted egress proxy. Fakes alone do not establish
package compatibility. App requests and retrievers may invoke the Runner
directly. Durable mutations, webhooks, package jobs, repo sessions and mail use
Temporal activities/workflows. One local namespace hosts the four task queues;
cross-namespace Nexus and cloud transport/security configuration remain future
work.

## Recorded phase results

| Phase | Result                                                               |
| ----- | -------------------------------------------------------------------- |
| P0    | Mock configuration, baseline and library spikes                      |
| P1    | Removed Cloudflare-only sibling workers and deployment plumbing      |
| P2    | Ten target acceptance files and explicit AWS fake factories          |
| P3    | PostgreSQL facade, baseline, RLS, pgvector and reader/operator roles |
| P4    | DynamoDB, S3, KMS, Identity port and frozen-key contracts            |
| P5    | Temporal workflows, schedules, activity retry and payload codec      |
| P6    | Native workerd Runner, broker, egress and fenced SQLite storage      |
| P7    | Node front door, MCP transport, UI and retained browser journeys     |
| P8    | SQL/reference cleanup and historical 1,128-file / 3,593-test gate    |

These are historical counts. Fresh demo evidence belongs in
[readiness](../docs/poc/readiness.md). Optional P9 infrastructure synth was not
implemented and is outside demo scope.

## Limitations and evidence

Local relational data uses PGlite; AWS services, source repos, interpreter
checks, mail and Identity use explicit fakes. No cloud deployment is implied.
[POC architecture](../docs/poc/architecture.md) identifies these components.
[Remaining ceilings](../docs/migration/p8-shortcuts.md) retain implementation
limits, and the
[reference allowlist](../docs/migration/cloudflare-reference-allowlist.json)
retains exact compatibility/history exceptions.

[Recorded P0–P8 history](../docs/audits/migration-2026-10-04/p0-p8-execution-history.md)
and the [dated evidence summary](../docs/audits/migration-2026-10-04/index.md)
preserve the original phase gates, deletion logs, snapshots, deviations and
production proposals. ADRs, SQL migration history and ledgers remain intact.

## Agent protocol

Follow the demo plan in order and record fresh evidence. No git writes,
production workflows, deployment, data copying, cutover, preview testing or PR
shipping. Use synthetic local data. Install with `HUSKY=0` and
`--ignore-scripts`. Use targeted tests during implementation and the unchanged
authoritative `CI=1 npm run validate` after application changes. Live proofs use
only explicitly configured existing sandbox resources and never example
credentials.
