# Run records

`RUN_RECORDS` is the owner-scoped history/log/triage port. Its DynamoDB adapter
is `aws/dynamo-runs.ts`; callers retain the existing run contracts and `runs`
MCP domain. `RunLog` binding names in compatibility fixtures describe this
contract rather than an active Durable Object. Existing result/status and
redaction behavior remains in `run-records/`.

Run items use one account partition (`pk = userId`) and `sk = run#id`. The
sparse `runs-by-started` index lists newest-first history. Claim pointers retain
`claim#surface#key`; quota and observability records remain separate items. Logs
use S3 through the object port and the frozen `run-logs/<userId>/<runId>.json`
key contract. A terminal write and activation/job counters use one transaction.
Caller-owned storage IDs and provenance remain attached to records.

History reads hide expired rows independently of DynamoDB TTL. The adapter keeps
30-day run history and a 2,000-run owner cap, heals stale running records, and
preserves owner-scoped triage. Surface idempotency uses a separate 90-day claim
contract plus encrypted S3 terminal results; it does not rely solely on Temporal
history retention. See [storage contracts](./data-storage.md).

Temporal manages workflow and invocation execution. `PackageInvocation`,
`PackageWorkflowRun` and owner projection registries survive worker restarts.
Visibility and projections support existing workflow-list/cancel behavior.
Completion bookkeeping can retry independently of package effects. Existing
execute, job, HTTP mutation and outbound-email handlers keep their
single-attempt policy. The demo's injected retry failure occurs before package
execution.

The local POC uses the real adapters over explicit in-memory DynamoDB/S3 fakes.
It proves caller ownership and application behavior, not cloud retention, backup
or read-unit capacity. Fleet scans, large-owner listing costs, distributed
broker callbacks and durable cloud stores remain in
[the limitations inventory](../../migration/p8-shortcuts.md). Historical RunLog
implementation details are preserved in
[the audit archive](../../audits/migration-2026-10-04/index.md).
