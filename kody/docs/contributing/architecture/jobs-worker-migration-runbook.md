# Package jobs in the POC

Package-owned configuration lives in PostgreSQL `jobs` rows. Temporal Schedules
reflect enabled state and invoke `JobRun` on the execution queue; Deno runs the
package handler through the authenticated broker. Owner isolation and existing
job IDs, manifest behavior and published package contracts remain in force.
Local defaults use PGlite and explicit service fakes.

The [jobs/runtime/email reference](../../poc/jobs-and-email.md) describes retry
limits, storage and schedules. The [presenter flow](../../poc/demo.md) includes
a real one-time scheduled run and a deferred workflow surviving worker restart.

The
[original worker ownership and transfer runbook](../../audits/migration-2026-10-04/legacy-jobs-worker-migration-runbook.md)
is historical evidence for ADR
[0016](../decisions/0016-mono-worker-extraction.md). Production ownership,
migration, provisioning and deployment remain outside the current POC. No
transfer, table copy or deployment action follows from this page.
