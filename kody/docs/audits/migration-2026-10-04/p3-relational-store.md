> Historical evidence preserved on 2026-10-04. Commands and topology below
> describe the recorded phase, not current demo instructions.

# P3 relational store progress

The POC relational harness runs the application schema on PostgreSQL through
PGlite. `aws/pg-database.ts` supplies the same transaction and prepared-query
implementation to PGlite and a production `pg` connection pool. The target test
environment exposes it as `APP_DB` and `APP_DB_READER`.

## Schema and isolation

`migrations-pg/0001_baseline.sql` contains the final schema and seed rows from
all 71 application migrations and the retained jobs migration: 96 tables. The
jobs worker's alarm-state table is excluded. Text timestamps, serialized JSON,
integer flags, constraints, indexes, RBAC seeds and the community-fork delete
triggers retain their application contracts. This is a POC schema squash, not an
upgrade path for a populated production database.

`0002_rls.sql` enables and forces row-level security on user-owned tables,
including all 62 tables with a literal `user_id` column. Integer owners resolve
through `users.stable_user_id`; secret and value entries inherit ownership from
their bucket. Tables with owner columns such as `submitter_user_id` also have
policies. Missing user context returns no owned rows. The runtime roles do not
own tables and cannot create schema objects.

The separate `kody_admin` role covers account/RBAC administration, operator
system email, submitted platform feedback, and sanitized public community
activity views. It has no access to passkeys, secrets, or package source.
Application authorization must choose this role only after the corresponding
permission check. The ordinary reader and writer have no membership in it.

Every facade operation sets `app.user_id` locally inside its transaction.
Batches roll back together and reject statements created by another database
facade. Pool transactions hold one client through commit or rollback and release
it on either path. Readers use a PostgreSQL read-only transaction as well as
SELECT grants, including when SQL contains a writable CTE or row lock. Prepared
SQL cannot contain transaction control or multiple statements.

Integer results are converted to JavaScript numbers only within the safe integer
range. Insert callers use `RETURNING`; the facade does not invent a SQLite
`last_row_id`.

## Search and embeddings

`0003_vectors.sql` stores 1,024-dimensional embeddings, JSON metadata and a
PostgreSQL full-text document. The search adapter preserves vector IDs and
namespace strings, scopes reads and mutations by owner, supports cosine ranking
and metadata filters, and exposes full-text lookup. Builtins use
`__kody_builtin__`: runtime roles can read them, and a separate `kody_indexer`
role can write only builtin vectors.

The Bedrock port invokes Titan v2 with normalized 1,024-dimensional output and
validates the response. The target harness provides deterministic embeddings
without network access. The request contract follows the
[AWS Titan v2 documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-text-embeddings-v2.html).

## Audit storage and operator configuration

The dedicated `audit-migrations-pg/0001_audit_events.sql` schema runs in a
separate database. `createPgAuditPools` exposes an INSERT-only `AUDIT_DB` and
read-only `AUDIT_DB_READER`; neither role can update or delete events. The
target harness creates a separate PGlite instance and closes both stores. The
audit pipeline retains hashed identifiers, query filters, pagination and sink
failure reporting. It no longer retries disconnected appends: the connection
error can arrive after commit, so replaying an append could duplicate the event.
Durable retry needs an event idempotency key before it is enabled.

`0004_operator_config.sql` grants the restricted admin role banner and feature
flag configuration writes, including per-user flag overrides. Ordinary readers
see global configuration and only their own dismissals and overrides. Banner
dismissal uses `ON CONFLICT DO NOTHING`; deleting the banner cascades
dismissals. The existing feature flag service tests run on PGlite instead of a
handwritten SQL emulator, covering rollout, opt-in audience, overrides, stale
flags, and operator attribution. The MCP mutation journey also uses the separate
audit sink. Exposure upserts use positional binds and qualify the counter in the
PostgreSQL conflict clause. Service timestamps remain ISO text.

Services use the public prepared-query shape `SqlDatabase`. Legacy bindings can
still satisfy that shape while request environments migrate; the PostgreSQL
facade retains its runtime checks for statement ownership and transaction scope.
The Postgres-only isolation acceptance case now exercises actual application
rows and child secrets with ordinary roles. The broader blocked-account
acceptance journey still awaits its owning implementation phase.

## Identity activation and background reads

Activation timestamps use PostgreSQL positional parameters and compare UTC
calendar days explicitly. First-seen timestamps and the first MCP client name
remain write-once; repeat activity advances `last_active_at` only on a later UTC
day. The activation and first-search tests use the shared PGlite baseline
instead of handwritten SQL emulators. They cover concurrent first-search claims,
all six activation stages, offset timestamps, and cross-user writes denied by
RLS.

The former background identity Workers suite runs in the Node pool with scoped
PostgreSQL reader/writer roles. It checks persisted role and permission reads,
cross-user identity denial, and suspended or unverified account rejection
followed by immediate recovery after unsuspension or verification. The shared
background resolver checks email verification as well as suspension. Background
identity, RBAC persistence and activation services accept the public
`SqlDatabase` query shape. RBAC mutations and both administrative account
creation services use PostgreSQL-compatible SQL. Signup/provider handlers and
their remaining authentication fixtures still need conversion.

## RBAC mutations and account creation

Role assignment uses `ON CONFLICT (user_id, role_id) DO NOTHING`. PostgreSQL
last-admin removal locks the admin role inside a transaction before a separate
count-and-delete statement, so a waiter counts using a fresh statement snapshot.
The legacy SQLite path keeps its single-writer delete. The shared query type
exposes the PostgreSQL facade's existing transaction method as optional during
caller conversion.

`0005_identity_administration.sql` lets the restricted admin role read email
reservations for account allocation. It adds no access to setup tokens or user
content. Ordinary writers may insert only their own default user role; they
cannot insert an admin role or update/delete memberships. Authorized role
administration uses `kody_admin`.

Admin-created person accounts and platform accounts obtain their integer ID with
`RETURNING id`. Their `forUser` callback supplies the newly allocated account's
ordinary writer for email claims and password setup tokens. Legacy bindings may
still reuse the input database. Production request construction must supply the
restricted admin database after authorization and the scoped writer callback
when those entrypoints migrate to PostgreSQL.

Creation, former-email reservation and app permission journeys use the shared
PGlite baseline. They cover duplicate and generated usernames, reserved platform
scopes, seven-day hashed setup tokens, former-address release without identity
reminting, role unions, revoked permissions, reader and cross-user denial, and
the last-admin invariant. Creation failures at role assignment, email claiming
or token insertion clean up the partial account and its child rows. PGlite
serializes transactions; its concurrent-removal journey does not establish
contention behavior on multiple production PostgreSQL connections.

## Platform feedback, Discord, OIDC and operator analytics

Platform feedback submission uses the submitter's scoped writer. RLS rejects
feedback attributed to another account and hides other submitters' rows. The
restricted admin role reads feedback and updates only review columns; it cannot
author feedback or rewrite its content. The service, admin loader and stale
revision journeys run on PGlite. The handwritten feedback schema fixture was
deleted.

Discord membership and role sync read linked identities and the Stripe plan
through the signed-in user's scoped reader; another user's reader sees no linked
identity. OIDC UserInfo verifies the token subject through that subject's
reader. Unverified subjects and other users' readers are refused.

`0006_operator_analytics.sql` adds the read-only `kody_analytics` role. It
selects fleet-wide `feature_flag_exposure_rollups` and `usage_rollups` and
cannot read users or write counters. The flag metric readout's relational path
runs through it: window and flag filters, mixed and override cohorts, and the
ordinary reader's one-user view are checked on PGlite. The Analytics Engine
branch is unchanged; its Firehose/Athena replacement is outside P3. Admin
insights extend this role's grants when they migrate.

The platform feedback subscription Workers suite executes package code and reads
the RunLog ledger, so it moved to P6. Mock-only tests that pass
`{} as D1Database` into `Env`-typed helpers keep those placeholders until P7
replaces `Env` with `AwsEnv`.

## Admin insights and per-account reports

`0007_admin_insights.sql` extends `kody_analytics` with column-level SELECT on
account labels, plans, entitlement flags, deletion state and activation stamps,
plus `user_roles`, `roles`, `platform_feedback.status` and
`credit_wallets.balance_micro_usd`. Email, credentials, profile text and
feedback content remain denied. Launch signals, fleet usage rankings and the
RunLog snapshot user listing read through this role; their tests seed real rows
and check deleting-account, other-month and observe-only exclusions.

Mailbox retention lists owners through `kody_admin`; the system mailbox and
deleting accounts are excluded and the keyset cursor is checked. PostgreSQL
folds unquoted aliases to lower case, so the listing's `AS userId` returned
`userid` and every fan-out received `ownerId: undefined`; the alias is quoted.

The meter parity report and per-account usage drill-down read through the
subject account's scoped reader. Another account's reader sees no row and gets
`null`. The usage tests count real saved packages, jobs and secrets. A stored
plan outside the registered names cannot be inserted because of the schema
CHECK, which replaces the former invalid-plan loader case.

Fleet sweeps still pass the operator environment to per-user entitlement reads;
under RLS those must come from per-subject readers when request environments are
constructed. `users-data.ts` (`LIKE`, `COLLATE NOCASE`), `credit-grants.ts` and
the entitlements storage recompute (`CAST AS BLOB`) remain SQLite-dialect until
their owning folders convert.

## Account export and deletion

Per-user RLS hides the rows account deletion must anonymize and export must
read: grants an admin made on other ledgers, reviews, bans, lease repairs and
codemod filters that name the subject. `0008_account_subject.sql` is generated
from `accountUserDataTargets` and adds two roles keyed to `app.user_id`.
`kody_subject_reader` selects exactly the rows the export inventory selects,
plus the subject's job rows. `kody_subject_purger` selects and deletes every
inventory row; it cannot insert or update application rows.

PostgreSQL checks an UPDATE's new row against SELECT policies, so an RLS policy
cannot let the purger rewrite the column that made a row visible. The
inventory's non-delete targets run in `kody_subject_anonymize()`, a
`SECURITY DEFINER` function owned by the NOLOGIN `kody_subject_anonymizer`. It
reads the subject from the caller's transaction, executes only the generated
statements and is executable only by the purger. On PostgreSQL the deletion
batch calls it first, in the same transaction as the deletes; a failure rolls
back the whole account. The tests seed cross-user rows, run that batch and check
that no covered column still holds the subject's stable or integer id, while
bystander rows survive and ordinary writers are refused.

Export pages each table by its primary key, read once from the catalog; the
cursor is the JSON key tuple of the last row. R2 export scans listings and
sources by `id` and signs version 4 cursors, so older cursors restart. The JSON
substring predicate uses `length(replace(...))`, which both dialects run.

The unverified-account purge lists and claims candidates through `kody_admin`,
which gains SELECT on `oauth_connections.user_id` for the linked-provider
exemption. Each deletion receives the subject's environment from `subjectEnv`.
The scheduled lane and admin capability still pass the legacy environment until
request environments are constructed. Prepared SQL may not call `set_config`, so
a statement cannot rebind `app.user_id` inside a transaction.

## Public community metadata

Public community metadata is the fourth documented cross-user exception.
`0010_community_public.sql` adds the read-only `kody_community` role.
`getCommunityDb(env)` returns `COMMUNITY_DB` and falls back to `APP_DB` until P7
constructs request environments. The role reads only these rows:

- Active listings, plus the ratings, forks and activity on them.
- Saved packages with `is_private = 0`, plus the sources behind those packages
  and listings.
- Public profile columns of `users`.
- Ban status.
- URL redirects, plus webhook and job counts for public packages.

Column grants deny email, credentials, rating notes and report content. The role
cannot write. Browse, search, overview, featured shelves, profile pages,
`/@owner/kody-id` resolution, and fork, rate and report preflights use it.
Package URL resolution reads only `username, stable_user_id`, not the
email-bearing identity lookup. Ban checks also use this role, because a
delegated actor's ban row is not visible to the owner's writer. Reports find
only active listings, as a visitor would.

Owner writes stay on `APP_DB`. Three owner actions touch other users' rows:

- Unpublish clears the listing's ratings and activity events.
- Republish re-points forks orphaned by an earlier unpublish.
- A username claim clears any retirement row for the claimed name.

Owner RLS hides those rows. PostgreSQL also checks a DELETE or UPDATE predicate
against SELECT policies, which would show rating notes to the listing owner.
Each action therefore runs in a `SECURITY DEFINER` function owned by NOLOGIN
`kody_community_curator`. The listing functions require the caller to own the
target listing. The username function acts only on the caller's current
username. Unpublish clears engagement before deleting the listing, while the row
still names its owner.

Moderation runs as `kody_admin`: featuring, report resolution, bans,
delist/delete, orphan fork cleanup and activity review. The migration grants it
listing status and featured updates, listing deletes, report resolution, bans,
and fork, rating and activity deletes. Rating notes stay denied. The unused
`public_community_*` views from `0002_rls.sql` are dropped. Delisted listings
are moderation state, so `includeDelisted` reads select the admin environment's
`APP_DB`.

The community folder's SQL tests run on PGlite through
`test-support/aws/test-community-db.ts`, which seeds as the schema owner and
exposes per-user writers, the community role (with captured SQL) and the admin
role. SQLite `LIKE` folded ASCII case; listing and profile token filters now
compare `lower(column)`. Redirect timestamps are bound instead of using
`strftime`.

## Package sharing, platform scopes and scope grants

Package share grants are consent-scoped cross-user access.
`0011_package_registry.sql` keeps grant rows unforgeable. Only an owner creates
or deletes a grant, and only for their own id. A guest updates only a grant
addressed to them while it is pending or accepted, so a revoked or departed
grant cannot be revived. Writers cannot change a grant's package or owner;
UPDATE is granted only on status, trust and timestamp columns. Callers see these
grants:

- Grants they own.
- Grants naming them as grantee.
- Unbound pending invites for their own verified email.

A pending or accepted grant shows the guest the owner's saved package and its
source. That policy reads grants through the caller's own RLS, so a forged or
revoked grant exposes nothing.

`users` rows hold credentials, so other accounts are read through definers owned
by NOLOGIN `kody_account_directory`:

- `kody_share_find_invitee` looks up an invitee by exact username, or by exact
  email for person accounts.
- `kody_share_peer` returns the other party of a visible grant, or the caller:
  identity plus the entitlement columns used by plan checks. Email reaches only
  an owner about their grantee, for invite delivery.
- `kody_platform_account` and `kody_platform_account_usernames` resolve platform
  scopes such as `@kody` for any role.

`share-grants.ts` and `scope-grants.ts` call these definers on PostgreSQL and
keep their SQLite queries for legacy bindings. A guest's plan checks resolve the
owner's plan from the peer row with `resolveUserPlanFromRow`. Under RLS, a grant
not addressed to the caller is invisible, so accepting it reports "no pending
invitation" rather than "not addressed".

Package scope grants let a person act inside a platform scope. Ordinary writers
and readers may only read the grants they are party to; `kody_admin` creates and
removes them after the permission check.

`saved_package_search_index_debt` rows stay under owner RLS, so another account
cannot take over a package's debt row. The saved-package name sort uses
`LOWER(name)` instead of SQLite's `COLLATE NOCASE`.

## Search index embeddings and fingerprints

The former `vectorize` folder is `search-index`. Embeddings come only from the
`BEDROCK_EMBEDDINGS` port (Titan v2, 1,024 dimensions, the `search_vectors`
column width). The wrapper sends at most eight concurrent texts, truncates each
to 2,000 characters, and rejects misaligned or wrong-sized rows. Production
without a port fails; other environments use the deterministic 1,024-dimension
fallback. The Workers AI and AI Gateway embedding path is gone; Workers AI
remains only for the Jev reranker.

`getCapabilityVectorIndex` returns the pgvector adapter's `SearchIndex` type. It
prefers `SEARCH_INDEX` and falls back to legacy `CAPABILITY_VECTOR_INDEX` test
doubles until P7 replaces `Env`. Reindex helpers need only its `upsert`.

Embed fingerprints run under owner RLS. Another account can neither read nor
forge them, and deleting by vector id leaves other accounts' rows alone.
`0009_search_index.sql` lets `kody_indexer` read and write only builtin
fingerprints, so builtin reindex can skip unchanged capabilities. That reindex
needs an environment whose database is the indexer role and whose index is bound
to `__kody_builtin__`. The fingerprint hash includes the constant model id,
which must stay equal to `BEDROCK_EMBEDDING_MODEL_ID`.

`createDb` recognizes the PostgreSQL facade and reuses the installed Remix
PostgreSQL driver for account queries. The driver's query client delegates to
the scoped facade, so generated SQL retains reader restrictions and per-user
RLS. Inserts and updates return rows through PostgreSQL `RETURNING`. Tests cover
account lookup, case-insensitive filters, generated IDs, update/delete results,
reader write refusal, cross-user refusal, and rollback of account creation.

Multi-query transactions use `facade.transaction(tx => createDb(tx))`. Native
Remix transaction control and migration scripts are unavailable through this
restricted query client; role and schema management remain host operations. The
SQLite driver stays available to callers awaiting conversion.

## Signed-out token links and rate limits

Password reset and email verification links are opened before sign-in. Owner RLS
hides their token rows from the pre-auth writer, which has no user context.
`0012_pre_auth_tokens_rate_limits.sql` adds two definers owned by NOLOGIN
`kody_token_resolver`: `kody_password_reset_owner(hash)` and
`kody_email_verification_owner(hash)`. Each returns the owner's stable id and
nothing else, for expired tokens too, so the application can still report
expiry. `resolveTokenOwnerDb` in `identity/token-owner-db.ts` calls the definer.
It then continues on the owner's scoped writer from the request environment's
`APP_DB_FOR_USER` factory, and throws on PostgreSQL when that factory is
missing. Reset confirm clears only the owner's TOTP, passkeys and linked
providers. The tips unsubscribe link is signed rather than stored, so it uses
the same factory directly with the account the signature names.

Admin email verification stamps `users` as `kody_admin`, which still has no
token-table access, and writes token rows through the target account's writer.
Admin target lookup by email or username compares `lower(column)` instead of
`COLLATE NOCASE`.

The rate-limit fallback used by search, webhooks and destination verification
keys rows by user id or IP. `_rate_limits` is now part of the schema, with no
grants to runtime roles. Writers call `kody_rate_limit_take` and
`kody_rate_limit_release`, owned by NOLOGIN `kody_rate_limiter`, and readers
cannot call either. Each call holds a per-key transaction advisory lock. D1's
single writer made the count-then-insert atomic; PostgreSQL's READ COMMITTED
does not. The SQLite path still creates its table at runtime for legacy
bindings.

Fleet scans such as the email verification stall alert read every account and
run as `kody_admin`. An ordinary writer's scan finds nothing.

## Account security and email changes

`0013_account_security.sql` extends the same pattern to other signed-out entry
points. `kody_email_change_owner` and `kody_email_claim_release_owner` map a
token hash, and `kody_passkey_owner` maps a WebAuthn credential id, to the
owner's stable id. The email-change and former-email release links then run on
the owner's writer from `APP_DB_FOR_USER`. Passkey sign-in reads the passkey,
updates its counter and stamps activity on that writer. The assertion is still
verified against the stored public key, so a credential id alone signs nobody
in. The 2FA verify step uses the account named by the signed pending cookie.
Passkey registration treats the insert's unique violation as "already
registered", because RLS hides other accounts' credentials.

A signed-in email change must know whether the new address belongs to another
account. `kody_email_reserved_for_other(email, except_user_id)`, owned by
`kody_account_directory`, checks login emails, active former-email claims and
the implicit `sha256(email)` stable id, and returns only a boolean.
`isEmailReservedForOtherAccount` calls it on PostgreSQL; `kody_writer` and
`kody_admin` may execute it, readers may not.

The 2FA, passkey, password change, email change, former-email release and
`/session` tests run on PGlite with bystander accounts. `CURRENT_TIMESTAMP`
assignments in these paths are bound UTC values, so PostgreSQL does not store
its own text form. Login, signup and password-reset requests still look accounts
up by email before sign-in, and successful signup still needs the new account's
writer. Both remain open.

## Signed-in session, profile and verification resend

Session resolution (`request-auth-cache.ts`, `readAuthenticatedAppUser`), the
account and pending-verification pages, profile settings and the verification
resend run on PGlite with the session account's scoped writer. A cookie naming
another account resolves nobody, because RLS hides that row. A failed roles read
still falls back to the user row with no roles. A deleting account's session no
longer authenticates. The resend's writable check (409) only catches a purge
claim that lands after the session lookup.

Username changes rely on the `users_username_key` unique violation, because RLS
hides the other account from the pre-read. With RLS, PostgreSQL omits the
`Key (...)=(...)` detail for rows the caller cannot see, so
`getUniqueConstraintField` derives the column from the default
`<table>_<column>_key` constraint name and the reported table. A rename retires
the old username to `username_redirects` through the curator definer. The
verification email delivery index upserts with `ON CONFLICT` instead of SQLite
`INSERT OR REPLACE`.

Page auth prefetches feature flags without awaiting them, and redirects never
render. Tests settle that query with `loadRequestFeatureFlags` before closing
the database.

## Signed-out entry: login, signup, reset request and provider sign-in

`0014_auth_entry.sql` covers the remaining signed-out entry points, which know
only an email or a provider identity before a session exists.
`kody_account_email_owner(email)` and
`kody_oauth_connection_owner(provider, provider_id)`, owned by
`kody_token_resolver`, return the owner's stable id and nothing else. Login, the
password-reset request and provider sign-in then continue on that owner's writer
(`APP_DB_FOR_USER`), where the password or provider identity is still verified.
A wrong password and an unknown address still look the same.

Self-service signup allocates its stable id through `kody_signup_identity`
(owned by `kody_account_directory`), which mirrors `allocateSignupIdentity` and
answers only the outcome. The new row, default role, email claim, verification
token, connection and pending share invites are written on the new account's own
writer (`getNewAccountDb`); RLS lets it create and see only itself. A random-id
collision fails the insert's unique check. `kody_username_taken` answers "is
this public handle taken" as true/false for signup and generated usernames. A
referral code names the referrer's username; `kody_referral_referrer` returns a
person account's stable id so the referee's writer can record the referral row.

Signed-in provider linking stays on the session account's writer: a connection
owned by someone else is invisible there, so the insert's unique violation
reports the conflict.

## Retention and operator sweeps

`0015_retention.sql` adds NOLOGIN `kody_retention`: fleet-wide SELECT and DELETE
on the seven pruned growth tables plus three `entity_sources` columns, and
nothing else. `audit-migrations-pg/0002_audit_retention.sql` adds
`kody_audit_retention`, which reads only `id` and `timestamp` and may delete
audit events; the runtime audit roles stay append-only and read-only. Retention
deletes by primary key instead of SQLite `rowid`, using `(a, b) IN ((?, ?), …)`
row values for composite keys, chunked to the bind limit.

`0016_operator_sweeps.sql` lets `kody_admin` list usage-campaign candidates by
`last_evaluated_at`. Each candidate's campaign rows and send ledger are then
read and written through that account's writer (`getAccountEnv`); the operator
never sees campaign state.

## Dialect fixes found by the remaining batches

- The facade maps SQLite numbered binds (`?1`, `?2`) to `$1`, `$2`. They were
  previously rewritten as `$11`, which broke the connection-disconnect guard.
- Removing a package from secret approvals uses `jsonb_array_elements_text` and
  `pg_input_is_valid` on PostgreSQL instead of `json_each` / `json_valid`.
- Admin user management runs as `kody_admin`, with verification tokens on the
  target account's writer.

## What stays outside P3

Tests that still use SQLite fixtures belong to folders owned by later phases:
integrations, OAuth clients and secret providers (P4), webhooks (P5). The
row-map emulator in `test-support/account-deletion.ts` stays for
failure-injection orchestration tests (Stripe, OAuth, Durable Objects, the
deletion fence), where SQL is not under test. The full deletion now also runs on
PGlite through the subject purger. Single-query canned stubs remain where a test
covers non-SQL logic.

`create-d1-from-sqlite.ts`, `apply-all-migrations.ts` and `d1-retry.ts` keep
importers only in P4–P6 folders. The legacy D1 driver
(`d1-data-table-adapter.ts`) and `d1-like-pattern.ts` serve legacy bindings
until P7 introduces `AwsEnv`. Request and activity environments, including
`APP_DB_FOR_USER`, the pre-auth writer and per-role databases, are built in P7.
Default inbox provisioning at signup still takes a D1-typed binding until P6
moves mailboxes.

The P2 acceptance stubs remain expected failures until their owning phases
implement them. `npm run validate` remains the authoritative local gate under
the current repository instructions.
