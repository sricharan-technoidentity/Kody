# Runtime architecture

The current migration POC runs a Node front door, Temporal workflows/activities,
and a Deno Runner. Keep the existing `packages/worker` and `packages/shared`
workspace. Start at
[the POC architecture and service matrix](../../poc/architecture.md) for
implemented components versus local fakes, then follow
[the presenter flow](../../poc/demo.md) or
[AWS proof prerequisites](../../poc/aws.md).

- [Request lifecycle](./request-lifecycle.md): owner routing, reader/writer
  split, Temporal mutations and sandbox execution
- [Authentication](./authentication.md), [authorization](./authorization.md):
  preserved cookies, OAuth grants and operator boundaries
- [Data storage](./data-storage.md): PostgreSQL, DynamoDB, S3, KMS, storage
  cells and frozen compatibility keys
- [Run records](./run-records.md): owner history, logs, claims, triage and
  Temporal projections
- [Integrations](./integrations.md),
  [MCP client servers](./mcp-client-servers.md): encrypted connection metadata,
  vault ports and session workflows
- [Webhooks](./webhooks.md), [email primitives](../../use/email-primitives.md):
  preserved ingress/delivery behavior
- [Packages and manifests](../packages-and-manifests.md),
  [package storage](../package-storage-static-imports.md): unchanged
  package/runtime contracts
- [POC jobs and email execution](../../poc/jobs-and-email.md): Temporal
  Schedules, delivery workflows and local provider limits
- [Decision index](../decisions/index.md),
  [known limits](../../migration/p8-shortcuts.md): accepted constraints and
  deferred work
- [Primitives taxonomy](./primitives.yaml): stable classification used by
  repository checks

The [migration overview](../../../planss/kody-migration-plan.md) records P0–P8
outcomes and deferred production work. Worker fleet diagrams, old deployment
runbooks and phase reports are historical context in
[the audit archive](../../audits/migration-2026-10-04/index.md); they do not
define current startup commands or prove an AWS deployment. Local and individual
service checks remain separate in [readiness evidence](../../poc/readiness.md).
