# PostgreSQL schema and preserved migration history

The POC uses `packages/worker/migrations-pg/`: its PostgreSQL baseline, owner
RLS policies, pgvector schema and indexes, and reader/operator role grants.
Local PGlite fixtures apply these files in filename order. The demo seeds
synthetic accounts only; live schema application and data migration remain
deferred.

Retain the original SQL under `packages/worker/migrations/` and the append-only
`tools/migration-ledger.json`. `npm run migrations:check` verifies the
historical ledger and canonical LF hashes; the authoritative gate still includes
it. Previously deployed migrations are immutable. New corrections belong in new
numbered files, with distinct prefixes and ledger entries where required by the
checker. Keep complete Git history so it can resolve its pre-change baseline.

The historical SQLite/D1 schema is a compatibility reference, not the local POC
schema apply path. Its
[original authoring and bookkeeping notes](../../audits/migration-2026-10-04/legacy-migrations.md)
remain archived. Do not run obsolete remote apply commands for this POC.

Use [local development](./local-development.md),
[synthetic seeding](./seeding.md), and [checks](./checks.md). Optional
PostgreSQL service proof uses an already prepared sandbox schema and rolls back
its synthetic transaction; see [AWS proofs](../../poc/aws.md).
