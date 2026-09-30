# Kody Architecture — Component Reference

Sep 29, 2026

## Purpose and baseline

This is the as-is map of Kody's architecture, component by component, to serve as the baseline for moving it to an enterprise target architecture. It describes what exists today and does not propose the target.

- **Source:** the `kody` repository at commit `edc1189` (PR #2707, 29 Sep 2026), read from the repo's own architecture docs, decision records and source layout.
- **Scale:** about 3,000 TypeScript files, 217 markdown docs, 51 decision records.
- **How to read it:** sections 2–4 give the shape of the system, sections 5–16 cover each subsystem, section 17 covers how it is built and run, and sections 18–19 list the constraints and conflicts that matter for the migration.
- **Code paths** are relative to the repo root; most application code lives in `packages/worker/src/`.

## System overview and design principles

Kody is a multi-user platform that gives each user's own AI agent a durable home. The agent connects over MCP and gets memory, secrets, saved code packages, schedules and an inbox. Kody runs no chat model itself: the connected agent does the reasoning, and Kody stores and runs what it builds.

**The six primitives a user owns**

| Primitive | What it is | Where it runs or lives |
| --- | --- | --- |
| Memory | Durable facts surfaced to every connected agent | D1 rows plus Vectorize embeddings |
| Secrets and integrations | API keys and OAuth grants that code can use but the agent cannot read | Encrypted in D1; applied by the fetch gateway |
| Packages | Saved, versioned code with exports, an optional hosted app and its own storage | Artifact repos for source; `kody-runtime` for execution |
| Jobs, workflows, webhooks | Triggers that run package code with no model in the loop | `kody-jobs`, Cloudflare Workflows, origin webhook ingress |
| MCP servers | Remote MCP servers the user connects Kody to, as a client | `McpClientHub` Durable Object on `kody-platform` |
| Inbox | An email address per account; mail in can start work, mail out reports | `Mailbox` Durable Object, R2, Cloudflare Email |

**Invariants the codebase enforces**

- **Per-user isolation.** Every data access is keyed by `userId` at D1, Durable Object, Vectorize and runtime layers. Code that reads or writes without one is treated as a bug. Only four narrow cross-user exceptions exist: RBAC admin on `user`/`role`, operator system email, user-approved feedback, and metadata about public community listings.
- **Compact MCP surface.** Only `search` and `execute` are exposed as tools; everything else is a capability behind them.
- **Agent code never sees secrets.** Sandboxed code gets placeholders; the platform swaps in real values at the network edge, only for approved hosts.
- **Fail closed.** Ambiguous auth, missing timestamps or failed permission lookups resolve to "deny".
- **No conversation identity from transport.** A user may run many agents at once; conversation-scoped state needs an explicit id the client passes (ADR 0033).

**Explicit non-goals** (from `docs/contributing/project-intent.md`): per-organization tenancy or shared team workspaces, fine-grained delegation between many people inside one account, and enterprise SSO or directory provisioning. These three are the main points the enterprise migration has to reverse (see the last section).

## Deployment topology

Production is five Cloudflare Worker scripts on the request path plus three ops scripts. The origin (`kody-production`) takes every public request on `kody.codes` but deliberately owns no Durable Object classes. Stateful actors live on `kody-platform` and `kody-runtime`; scheduling lives on `kody-jobs` (ADRs 0016 and 0034).

&#91;embedded content: production worker fleet · 5 product scripts, 3 ops scripts\]

Arrows show who calls whom. The jobs worker is the only one that calls back into origin, through the `JobsHost` RPC entrypoint. Browsers reach hosted package apps directly on per-user `kody.run` subdomains, which route to `kody-runtime`.

| Script | Entrypoint | Public surface | Owns | Key bindings |
| --- | --- | --- | --- | --- |
| `kody-production` (origin) | `packages/worker/src/index.ts`; prod uses `production-worker.ts` | `kody.codes` | Remix, `/mcp`, OAuth, inbound email, 7 queue consumers, `JobsHost`, `DynamicWorkerUsageTail` | Platform and runtime DOs by `script_name`, `RUNTIME_WORKER`, `JOBS`, `HIGHLIGHT`, D1 `APP_DB` + `AUDIT_DB`, `OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`, 3 R2 buckets, `EMAIL`, rate limiters `AUTH_RATE_LIMITER` + `SENTRY_TUNNEL_RATE_LIMITER` |
| `kody-platform` | `packages/worker/src/platform-worker.ts` | `/__platform/health` only | DOs: `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`, `KodyFetchGateway` | `LOADER` + `APP_LOADER` (Worker Loaders), `ARTIFACTS`, `AI`, `IMAGES`, `CAPABILITY_VECTOR_INDEX`, 8 Analytics Engine datasets, 5 queue producers, runtime DOs by `script_name` |
| `kody-runtime` | `packages/worker/src/runtime-worker.ts` | `{user}.kody.run`, `/__runtime/health` | DOs: `StorageRunner`, `RunLog`, `PackageRealtimeSession`, `PackageAppRuntimeBridge`; Workflow `DynamicCallableWorkflow` | Worker Loaders, platform DOs by `script_name`, `JOBS`, D1, KV, 2 R2 buckets, Vectorize, `AI`, `PACKAGE_APP_BASE_URL` |
| `kody-jobs` | `packages/jobs-worker/src/index.ts` | none | DO `JobManager`; D1 `JOBS_DB` (`kody-jobs`); cron `*/5 * * * *` | `HOST` → origin `JobsHost`; queue `kody-scheduled-dispatch` + DLQ |
| `kody-highlight` | `packages/highlight-worker/src/index.ts` | none | Shiki tokenizer, `POST /highlight` | none |
| `kody-status` | `packages/status/worker.ts` | `status.kody.codes` | DO `StatusStore`; cron every minute | `JOBS`, HTTP probes to origin |
| `kody-nx-cache` | `packages/nx-cache/worker.ts` | `nx-cache.kody.codes` | Nx remote build cache | R2 `kody-nx-cache` |
| `kody-production-d1-backups` | `packages/backup-control-plane/worker.ts` | operator only | Workflows: D1 backup, DR restore, seal-day; crons `15 2 * * *` and `45 * * * *` | R2 `kody-production-backups` |

**Environments.** Each product script has `production`, `preview` (per-PR) and `test` configs. Production and preview wrangler configs for origin are generated by `tools/ci/production-resources.ts` and `tools/ci/preview-resources.ts`, which also create any missing D1, KV, R2 and queue resources. Locally, `npm run dev` runs origin, platform, runtime, jobs and highlight in one Miniflare process; Playwright tests run every DO class on a single `kody-test` script.

**Deploy scoping.** A UI-only change uploads origin alone. Guide markdown changes upload origin and platform, because MCP search bundles guides. `tools/ci/deploy-path-filter.ts` decides which scripts a change touches.

## Request lifecycle and routing

Every request to `kody.codes` passes one ordered chain in the origin's `fetch` handler; the first matching step answers. The default handler is wrapped by `OAuthProvider` from `@cloudflare/workers-oauth-provider`, so OAuth endpoints sit beside app routes (`docs/contributing/architecture/request-lifecycle.md`).

1. **Canonical-host check** (`app/canonical-host.ts`). In production, any host other than `APP_BASE_URL`, a package-app host or a legacy host gets `404`. `GET /health` is exempt for probes.
2. **Package-app host isolation.** Package code never runs on the app origin. `/@{user}/packages/*` redirects to the owner's `{user}.kody.run` subdomain with a handoff token; that subdomain serves only its own user's `/packages/{kodyId}/*`. Production fails with `500` if the package-app domain is missing or shares a registrable domain with the app.
3. **Public OAuth metadata:** OIDC discovery, JWKS, protected-resource metadata, and two Client ID Metadata Documents (Kody-as-client, and the official `@kodycodes/cli`).
4. **OAuth endpoints:** `/oauth/authorize`, `/oauth/authorize-info`, `/oauth/callback`, `/oauth/token`.
5. **MCP endpoint `/mcp`** (bearer token required). `mcp-auth.ts` authenticates, then routes by protocol era: 2025-era requests go to the sessionful `MCP` Durable Object on `kody-platform` (MCP SDK v1, `McpAgent`); `2026-07-28` envelope requests are served statelessly per request by `mcp/stateless-lane.ts` (MCP SDK v2). Both lanes share one tool registration, and each request logs a lane data point to Analytics Engine (ADR 0005).
6. **Public `@username` ingress:** `POST /@{user}/webhooks/:packageKodyId/:webhookName/:urlSecret` stays on origin; package-invocation and package-app paths forward to `kody-runtime` over the `RUNTIME_WORKER` service binding.
7. **Static assets** from the `ASSETS` binding (most files are served at the edge without entering the Worker).
8. **App routes** via `app/handler.ts` → `app/router.ts`, with patterns in `universal/routes.ts`. Also serves agent-discovery documents: `robots.txt`, `sitemap.xml`, `/auth.md`, `/.well-known/mcp/server-card.json`, `/.well-known/api-catalog`, `/.well-known/agent-skills/*`, `security.txt`, and the OpenAI Apps verification token.

**Inside the app handler.** The handler validates env vars and sets cookie signing (`COOKIE_SECRET`). For signed-in HTML it loads the user row and RBAC roles in one D1 batch, then starts feature-flag evaluation in parallel. `runWithRequestContext` (`request-context.ts`) holds a per-request memo in `AsyncLocalStorage` and collects `Server-Timing` phases.

**Caching.** Anonymous marketing pages (`/`, `/pricing`, `/blog`, `/community`, `/onboarding`, `/docs/*`) are cached for 60 seconds with stale-while-revalidate, stored in `caches.default` only when the HTML stream completed. Public package pages cache for 60 seconds with no stale window, so unpublishing takes effect within a minute. Everything authenticated is `no-store`.

**Client side.** The browser app is a client router with preload-then-commit navigation: it runs a route loader and fetches JSON before changing the URL, so pages never flash a loading state (`docs/contributing/no-flash-navigation.md`). Code blocks are tokenized server-side by `kody-highlight` and painted as JSX, never `innerHTML`.

**Other entry points on origin:** the `email` handler (inbound mail), `queue` consumers, and the `JobsHost` RPC entrypoint called by `kody-jobs`.

## Identity and authentication

Kody authenticates three kinds of caller with three separate credentials: browser cookies, OAuth 2.1 bearer tokens for MCP, and a narrow handoff token for hosted package apps. All three resolve to one user row before any handler touches data (`docs/contributing/architecture/authentication.md`).

**User identity**

- `users.id` is an integer primary key used only for internal D1 joins; it never leaves the server.
- `users.stable_user_id` is SHA-256 of the signup email. It is the `userId` used in cookies, MCP contexts, Durable Object names and Vectorize metadata.
- `users.account_type` is `person` (signup) or `platform` (operator-created owner of an official package scope such as `@kody`; never logs in).
- Lifecycle columns: `email_verified_at`, `password_changed_at`, `suspended_at`, `deleting_at`, `plan`, `stripe_plan`.

**Credential types**

| Credential | Used by | Mechanism | Lifetime | Code |
| --- | --- | --- | --- | --- |
| `kody_session` cookie | Browsers | Signed with `COOKIE_SECRET`, `httpOnly`, `SameSite=Lax`; payload `v`, `stableUserId`, `email`, `issuedAt` | 7 days, or 30 with remember-me | `app/auth-session.ts` |
| OAuth access token | MCP hosts, CLI | `@cloudflare/workers-oauth-provider`, Authorization Code + PKCE; grants in `OAUTH_KV` | Short access token; refresh tokens do not expire but rotate | `oauth-handlers.ts`, `mcp-auth.ts` |
| OIDC ID token | MCP hosts requesting `openid` | RS256 JWT signed with `OIDC_SIGNING_PRIVATE_KEY_PEM`; JWKS and UserInfo endpoints | With token | `src/oidc/` |
| Package-app handoff token | Browsers crossing to `{user}.kody.run` | One-time token in `__kody_handoff`, exchanged for a package-app cookie | Snapshot of the source session | `app/package-app-handoff.ts` |
| Short-lived flow cookies | Login flows | `kody_verify` (2FA, 10 min), `kody_webauthn_challenge`, `kody_oauth_login` (PKCE state) | Minutes | `app/verify-session.ts`, `app/webauthn.ts` |

**Sign-in methods:** email and password (hash in `@kody-internal/shared/password-hash.ts`, 8-character minimum), optional TOTP 2FA (`verifications` table), passkeys via `@simplewebauthn/server` (`passkeys` table; counts as MFA-complete), and social login with GitHub, Google, X and Discord (`oauth_connections`). Social login auto-links to a verified account with the same provider-verified email.

**OAuth server details.** Clients register by Client ID Metadata Document (CIMD, preferred under MCP `2026-07-28`) or legacy dynamic client registration at `/oauth/register`. Scopes are only `openid`, `profile`, `email`; there are deliberately no per-capability OAuth scopes (ADR 0049). A token is valid for everything the user can do. `oauth-refresh-family.ts` keeps the current and previous refresh token valid so several hosts sharing one client do not revoke each other.

**Revocation by epoch fence.** Password reset or change writes `users.password_changed_at`. Any cookie or access token issued at or before that instant is rejected, and all MCP grants are revoked twice around the write. No revocation list exists; one known gap is that enabling 2FA cannot revoke already-issued stateless cookies.

**Chokepoints that fail closed.** `handleMcpRequest` in `mcp-auth.ts` is the single gate for `/mcp`: it validates the token, then rejects unverified accounts (`403 email_verification_required`) and suspended ones (`403 account_suspended`). The same suspension check runs in browser session resolution, package-app owner resolution, webhook ingress, inbound and outbound email, and `resolveBackgroundMcpUser` for jobs, workflows and invocations.

**Account lifecycle.** Open signup with mandatory email verification; unverified accounts are purged after 7 days by an hourly lane. Admins can create users by email and hand them a setup link. `POST /account/delete` runs a full cascade: every `user_id` D1 table, Vectorize entries, KV bundle keys, `StorageRunner` objects, OAuth grants, then the user row last so failures can be retried. Account export is also available as capabilities (`accountExportManifest`, `accountExportSection`).

**Rate limiting on credential endpoints** uses the Cloudflare `AUTH_RATE_LIMITER` binding, keyed per IP.

## Authorization, entitlements and feature flags

Three separate systems answer three separate questions: RBAC decides who may do what, entitlements decide how much, and feature flags decide whether a feature is shipped for a user yet. None of them has any notion of an organization.

**RBAC** (`docs/contributing/architecture/authorization.md`)

- Permission strings are `action:entity:access`: actions `create|read|update|delete`, entities only `user` and `role`, access `own` or `any`.
- Two roles are seeded: `user` (all `:own`) and `admin` (adds all `:any`). No runtime path grants `admin`; the first admin is set by SQL.
- Tables: `roles`, `permissions`, `role_permissions`, `user_roles` (keyed on integer `users.id`).
- The typed registry in `universal/permissions.ts` is the source of truth; a drift test compares it to migrations.
- `:any` is honoured only inside handlers that call `requireUserWithPermission` or `requireMcpUserWithPermission` explicitly. Roles load fresh on every request and are never baked into tokens.
- Everything else, such as a user's packages, secrets or memories, is protected by `userId` scoping in the data layer rather than by RBAC.

**Platform accounts and scope grants** (`platform-accounts.md`). A `package_scope_grants` row lets a person act inside a platform account's package namespace, such as publishing `@kody/...` packages. Storage is always written under the owner's id; the acting person appears only in the audit log. This is the only delegation mechanism in the codebase and the closest existing thing to a shared workspace.

**Entitlements** (`entitlements.md`, `src/entitlements/`)

- Plans: `free`, `standard`, `pro`, `max`. Every plan has finite limits; `max` is manual-only. The effective plan is the higher of a manual grant (`users.plan`) and the Stripe-derived `users.stripe_plan`.
- An entitlement ladder (`public` or `legacy`) keeps grandfathered limits for older subscribers.
- Count resources such as `saved_packages`, `secrets`, `scheduled_jobs`, `repo_sessions` and `stored_email_messages` are checked with `assertWithinEntitlement` at each create path.
- Daily counters (`execute_calls_per_day`, `outbound_fetches_per_day`, `job_runs_per_day`, `automation_invocations_per_day`, `email_sends_per_day`, `email_receives_per_day`) are consumed atomically in the per-user `UserMeter` Durable Object before any costly work. Free, Standard and Pro also have a weekly cap.
- `storage_bytes` is reserved atomically in `UserMeter` before writes.
- A minimum job interval applies per plan: 15 minutes on Free and Standard, 5 on Pro.
- Prepaid credits debit two meters: unique Dynamic Worker days per month and Durable Object rows read per month.

**Feature flags** (`feature-flags.md`). Flags exist only in code (`universal/feature-flags/registry.ts`); D1 stores state. Global rows in `feature_flags` hold `enabled`, `rollout_percent` and `audience` (`everyone` or `experiments_opt_in`); `feature_flag_user_overrides` forces a value per user. Exposures are logged to the `kody_flag_exposures` Analytics Engine dataset, and each flag declares a success metric read out in `/admin/feature-flags`.

**Site banners** (`site-banners.md`) are operator-managed announcements with page targeting, audience, schedule and A/B/C styling, edited at `/admin/banners` or by admin capabilities.

## MCP surface and capability registry

The MCP server registers exactly two tools, `search` and `execute`, plus a set of prompts (`mcp/register-tools.ts`). About 200 capabilities across 19 domains sit behind them and are reached from code as `kody.<capabilityId>(params)` inside `execute`.

**Two protocol lanes, one registration.** 2025-era MCP clients are served by the sessionful `MCP` Durable Object (`McpAgent`, SDK v1) on `kody-platform`. Clients on MCP `2026-07-28` are served statelessly per request (`mcp/stateless-lane.ts`, SDK v2). ADR 0005 plans the move to stateless-only. Server instructions are assembled per user (`assemble-mcp-server-instructions.ts`).

**`search`** (`mcp/tools/search*.ts`, about 60 modules) finds capabilities, official guides, saved packages and their exports, integrations, connected MCP servers, secret references (names only) and memories. Ranking fuses Vectorize similarity with lexical scoring, then reranks (`search-scoring.ts`, `search-jev-rerank.ts`). Broad queries return a domain index; `entity` lookups such as `package:{id}#{export}` or `guide:{id}` return full detail. New searchable kinds are added as search-entity plugins (`search-entity-plugins/`). Results come back as markdown with a matching `structuredContent` payload, so hosts that read either channel get the same call contract.

**`execute`** (`mcp/tools/execute.ts` → `mcp/executor.ts`) runs one ES module in a sandbox. The handler first consumes the daily `execute_calls_per_day` entitlement, then bundles, assembles providers and evaluates (see the next section). Responses carry `Server-Timing` phases `bundle`, `hydrate`, `provider-assembly`, `sandbox` and `run`, and are capped at 100 KB.

**Capability domains** (`mcp/capabilities/*/domain.ts`, counts are modules per domain):

| Domain | Modules | Covers |
| --- | --- | --- |
| `admin` | 53 | User admin, plans, suspension, banners, flags, meter parity, feedback triage, purge lanes |
| `repo` | 30 | Repo sessions: open, read, edit, commit, run checks, rebase, publish |
| `email` | 18 | Send, inbox read and delete, destinations, threads |
| `packages` | 15 | Save, get, list, update, delete, git remote, publish |
| `meta` | 14 | Capability listing, memory verify and upsert, guides |
| `community` | 11 | Search, get, publish, fork, rate public packages |
| `integrations` | 11 | OAuth apps and connections, token refresh |
| `secrets` | 11 | Save, list metadata, host approvals |
| `webhooks` | 8 | Create, rotate, list inbound webhooks and deliveries |
| `jobs` | 7 | Get, list, enable, run now |
| `mcp-servers` | 7 | Add and manage remote MCP servers Kody connects to |
| `runs` | 5 | Run history and logs |
| `account` | 4 | Account info, export |
| `apps` | 3 | Hosted package apps |
| `values` | 3 | Retiring; being folded into memories, storage and secrets (ADR 0022) |
| `storage` | 2 | Package storage access |
| `coding`, `mcp-server` | 1 each | Coding guides; Kody's own hosted MCP server settings |
| `invocation-tokens` | 0 | Retired by webhooks (ADR 0048) |

**How the registry is built.** Each capability is declared with `defineDomainCapability` (Zod input and output schemas plus a handler) and grouped with `defineDomain`. `builtin-domains.ts` loads domains lazily with `import()` to stay under the Worker startup CPU limit. `getStaticRegistry()` memoizes the built-in set per isolate; `getCapabilityRegistryForContext()` then adds `mcp:<server>` domains synthesized from the user's connected MCP servers and filters by role, permission and feature flag. Capabilities are embedded into the `CAPABILITY_VECTOR_INDEX` for search (`capability-reindex.ts`).

## Execution sandbox and package runtime

All user and agent code (ad hoc `execute`, package exports, jobs, webhooks, workflows, package apps) runs in Cloudflare Worker Loader isolates that have no access to the parent worker's `env`. Every privileged action is an RPC back to a trusted handler that re-checks the caller's `userId`.

**How one evaluation runs** (`mcp/executor.ts`)

1. The module graph is prepared: user code, the host-supplied `kody:runtime` module, and any `kody:@scope/package/export` imports resolved to published bundles (`package-runtime/module-graph*.ts`).
2. Providers are assembled: capability dispatchers, the `kody` accessor proxy, OAuth helpers, `packageStorage`, `workflows`, `secretHeaders`.
3. A stable Dynamic Worker id is derived from the user, the storage context and the module graph, so identical code reuses a warm isolate. Varying values must go in `params`, not in the code.
4. `env.LOADER.get(id, …)` loads the isolate with `globalOutbound` set to a `KodyFetchGateway` loopback, so every `fetch` from user code goes through the gateway.
5. Evaluation is raced against a deadline (90 seconds by default) and a concurrency permit. A `DynamicWorkerUsageTail` records Cloudflare-measured CPU per run.

**`kody:runtime` helpers** available to code: `kody` (capability calls), `createAuthenticatedFetch` and `oauthClientCredentials` (integrations), `secretHeaders` (derived auth headers), `packageStorage` (the package's own durable store), `workflows` (durable deferred work), `packageContext` (package metadata), and `kody.mcp["server"].tool(args)` for connected MCP servers.

**`KodyFetchGateway`** (`mcp/fetch-gateway.ts`) is the only network egress for sandboxed code. It consumes `outbound_fetches_per_day`, substitutes `{{secret:name}}` placeholders only for hosts the user approved, blocks requests back to Kody's own hostname, and enforces a per-fetch timeout. Integration tokens attached by `createAuthenticatedFetch` are restricted to that integration's `requiredHosts` (`execute-modules/integration-host-allowlist.ts`).

**Runtime Durable Objects** (all on `kody-runtime`):

| Object | Keyed by | Purpose |
| --- | --- | --- |
| `StorageRunner` | Storage id (per package per user) | SQLite-backed `packageStorage()` bucket; paged export for account export and DR |
| `RunLog` | User | Run history, logs and the idempotency ledger for every runtime surface |
| `PackageRealtimeSession` | Session | Realtime (WebSocket) state for hosted package apps |
| `PackageAppRuntimeBridge` | — | Bridges hosted app requests into the package runtime |

**Hosted package apps** (`package-runtime/package-app*.ts`). A package can ship a Remix-based app served at `{user}.kody.run/packages/{kodyId}/*`, a separate registrable domain from `kody.codes` so package code can never read app cookies. Browsers arrive through the handoff-token redirect described in the identity section. Client assets are bundled at publish time.

**Package invocations** (`package-invocations/`). `runSavedPackageModuleOnce` is the shared path for webhooks, HTTP package-export calls, subscriptions and workflow steps. It consumes `automation_invocations_per_day` before sandbox work and applies caller `Idempotency-Key` handling through `RunLog`.

**Bundles and caching.** Published package bundles are stored in `BUNDLE_ARTIFACTS_KV` (tracked in `published_bundle_artifacts`). Ad hoc `execute` always bundles fresh; package-to-package static imports keep the bundled snapshot until the dependent republishes.

## Packages, repos and community

A repo is Kody's base persisted primitive, and a package is a repo with the package extension switched on (ADR 0003). Source lives in Cloudflare Artifacts git repositories; D1 holds projections and pointers.

**Repos** (`docs/use/repos.md`). A plain repo is a `user_repos` row plus an Artifacts repo linked through `entity_sources` (`entity_kind = 'repo'`). Plain repos are live at HEAD: pushes land on the default branch with no publish step. `repoPromoteToPackage` runs full publish checks and flips the row to `entity_kind = 'package'` with a `saved_packages` projection.

**Package state has four parts** (`docs/use/packages.md`):

1. **Source**: the Artifacts repo rooted at `package.json`, which is the source of truth.
2. **Config**: `package.json#kody` metadata and package-scoped secrets keyed by package id.
3. **Storage**: one SQLite `StorageRunner` bucket reached through `packageStorage()`.
4. **Jobs**: schedules declared in the manifest, materialized as D1 job rows.

**Manifest `package.json#kody`** (schema `authoredPackageJsonSchema` in `package-registry/types.ts`): `description`, `tags`, `category`, `searchText`, `dependencies` (static `kody:@...` imports, cycle-checked at publish), `secretMounts`, `secretProvider`, `app`, `subscriptions`, `emits`, `webhooks`, `jobs`, `retrievers`. npm `dependencies` are allowed if they bundle for Workers. Publish requires non-empty `README.md` and `AGENTS.md`.

**Two edit lanes**

| Lane | For | Capabilities | Backing |
| --- | --- | --- | --- |
| Repo session | Agents without a filesystem | `repoOpenSession`, `repoReadFile`, `repoEditFiles`, `repoApplyPatch`, `repoCommit`, `repoDiff`, `repoRunChecks`, `repoRebaseSession`, `repoPublishSession` | `RepoSession` DO per session, `RepoSessionIndex` DO, R2 `REPO_SESSION_BLOBS` |
| Git lane | Agents with git | `packageGetGitRemote` / `repoGetGitRemote`, then `packagePublishExternalPush` | Short-lived authenticated Artifacts remote |

Sessions resume by an explicit `conversation_id`, never by user alone. Files over 10 MiB are rejected on the session lane. Publishing runs repo checks (manifest, bundle, typecheck, lint, docs), rebuilds bundles into `BUNDLE_ARTIFACTS_KV`, reindexes Vectorize, and syncs jobs, webhooks and subscriptions. Artifacts repo events flow back through a dedicated queue.

**Sharing without copying.** Three mechanisms exist, and none is a team workspace:

- **Fork**: a public package is copied into the forker's account as an inert source until they review and publish it (`communityFork`).
- **Share**: a paid account can invite another; after accepting, the guest can read and invoke but not write, and storage stays with the owner. Share grants are not scope grants (ADR 0050).
- **Scope grant**: a person acts inside a platform account's scope (previous section).

**Community catalog** (`docs/contributing/community-packages.md`). Making a package public sets `saved_packages.is_private = 0`, writes a `community_listings` row and a KV source snapshot keyed by commit SHA. Public pages are `/community`, `/@username/:name` and `/tree/:ref`. Community search is its own `community` domain, deliberately separate from personal `search` and vector indexes. Ratings, fork provenance, admin moderation and cached icons (R2 `COMMUNITY_ASSETS`) are handled here. Platform packages (`@kody/...`) are execute-only and fork-only (ADRs 0035, 0036).

**Codemods.** Operators can migrate every user's packages with platform codemods (`package-codemods/`) when a runtime contract changes.

## Secrets, integrations and MCP client servers

Credentials come in four forms, and in every form sandboxed code handles only a placeholder. The real value is decrypted server-side and attached at the fetch gateway, only for hosts the user approved (`docs/contributing/security.md`, `secret-host-approval.md`).

| Form | Placeholder in code | Stored in | Encryption | Host control |
| --- | --- | --- | --- | --- |
| User secret | `{{secret:name}}` | D1 `secret_entries` | AES-GCM with `SECRET_STORE_KEY`, AAD `user:<userId>` | Allowlist the user approves in the account UI; deny by default |
| Package-scoped secret | Mounted via `kody.secretMounts` | Secret buckets keyed by package id | Same | Same |
| OAuth integration token | `{{integration-token:<connection>}}` via `createAuthenticatedFetch` | D1 `user_integrations` (tokens), `user_oauth_apps` (client secrets), `platform_oauth_apps` | AES-GCM, purpose-bound AAD | Connection's `required_hosts_json` plus API base host |
| External secret provider | `{{secret/<provider>:<ref>}}`, e.g. 1Password | Resolved by a saved package that serves the provider | Provider's own | Same gateway rules; behind the `secret-providers` flag |

**Secrets** (`mcp/secrets/`, capability domain `secrets`). There is deliberately no plaintext `secret_get`; `secretList` returns names, allowed hosts and expiry only. Policy changes such as approving a host are only possible through the signed-in account UI, not MCP. Capabilities may not take secrets as inputs (ADR 0042). The owner can reveal a value in the browser under extra checks. Rotation of `SECRET_STORE_KEY` is documented in `secret-rotation.md`; the key is escrowed for disaster recovery as a passphrase-sealed blob.

**OAuth integrations** (`src/integrations/`, `docs/contributing/architecture/integrations.md`). An OAuth app holds provider client config; a connection is one connected account on that app. Apps are user-lane (bring your own client) or platform-lane (operator-provisioned; legacy connects only). Connections carry `usage_mode`: `any` (execute and every package) or `packages` (only listed package ids; execute denied). The connect UI is `/connect/oauth`; refresh is server-side via `integrationTokenRefresh`. OpenAPI documents can be bound through the `@kody/openapi` package.

**MCP client servers** (`src/mcp-client/`, `mcp-client-servers.md`). Users add remote MCP servers that Kody calls as a client:

- One `McpClientHub` Durable Object per user on `kody-platform` wraps the Agents SDK `MCPClientManager` and stores registrations, OAuth client records and tokens in its SQLite storage.
- D1 `mcp_server_settings` holds which servers are enabled, `usage_mode` and last error, so listing does not wake the object.
- A 30-second snapshot cache in `hub-client.ts` feeds the registry, which synthesizes an `mcp:<server>` capability domain per server. Code calls `kody.mcp["server"].tool(args)`.
- Outbound connections prefer MCP `2026-07-28` and fall back to the 2025 handshake. HTTPS only, except loopback. Static bearer tokens live only in the object, never in D1.
- Kody hosts its own Client ID Metadata Document so remote servers can identify it.

**Local-network tools** reach Kody the same way, as outbound MCP servers; the old inbound connector routes are retired.

## Triggers: jobs, workflows, webhooks, subscriptions

Four mechanisms start package code with nobody in the chat, and all four end in the same sandboxed run path with no model involved (`docs/guides/triggers.md`). Jobs run through `executeJobOnce`; webhooks, HTTP invocations, subscriptions and workflow steps run through `runSavedPackageModuleOnce`.

&#91;embedded content: trigger paths · 4 sources, 1 run path\]

Each path uses a different Cloudflare primitive for delivery, but all share entitlement checks, idempotency and run records.

| Trigger | Declared in | Delivery mechanism | Key code | Notable rules |
| --- | --- | --- | --- | --- |
| Job | `package.json#kody.jobs` (cron or interval, timezone, enabled) | One `JobManager` DO per user holds one alarm set to the next due job, read from `JOBS_DB`; on fire it calls origin `JobsHost.runDueJobsForUser` and re-arms | `packages/jobs-worker/src/manager-do.ts`, `src/jobs/service.ts` | Jobs must belong to a package (ADR 0032); plan interval floor; per-run scratch bucket |
| Workflow | `workflows.create({ code or exportName, runAt, idempotencyKey })` | Cloudflare Workflow `DynamicCallableWorkflow` on `kody-runtime`; `step.do` checkpoints, `step.sleepUntil` for later | `package-runtime/package-workflows.ts` | 3 retries with backoff, 5-minute step timeout; `concurrent_workflows` entitlement; one-shot only |
| Inbound webhook | `package.json#kody.webhooks` | `POST /@user/webhooks/:pkg/:name/:urlSecret` on origin; `ack` mode enqueues to `kody-webhook-dispatch`, `sync` invokes inline | `src/webhooks/` | URL secret is the credential; optional HMAC and replay window; 60/min default, 600 max; rotation keeps old URL for 24 hours |
| Subscription | `package.json#kody.subscriptions` keyed by topic | `kody-package-events-dispatch` queue fans events to subscribed packages | `package-invocations/subscription-dispatch.ts` | Topics include `email.message.received`, `run.error.recorded`, `integration.auth.failed`, `mcp.server.disconnected`; admin-only topics such as `user.created` |

**Platform maintenance lanes** are separate from user triggers. The `kody-jobs` cron fires every 5 minutes and fans due lanes onto `kody-scheduled-dispatch` (with a DLQ); if the enqueue fails the lane runs inline. All lanes except `job_schedule_watchdog` are forwarded to origin's `JobsHost.runScheduledLane`. The lanes are: `reconcile_artifacts_pushes`, `repo_session_cleanup`, `repo_session_index_backfill`, `reconcile_inbound_deliveries`, `system_email_retention`, `storage_bucket_estimate_backfill`, `oauth_purge_expired`, `retention`, `job_retention`, `unverified_account_purge`, `usage_aggregation`, `durable_object_duration_attribution`, `compute_overage_billing`, `auth_denial_alert`, `email_delivery_alert`, `email_verification_stall_alert`, `usage_entitlement_alert`, `kit_subscriber_sync`, `dr_export`, `dr_export_watchdog`, `job_schedule_watchdog`.

**Other queues on origin**, each with a dead-letter queue: email delivery events, Artifacts repo events, platform feedback dispatch, community activity dispatch, community listing published dispatch, package events dispatch, webhook dispatch.

**Retrievers** (`kody.retrievers`) are a fifth package-owned surface: they let a package contribute results to search or context, running in the same sandbox.

## Memory and search index

Memories are D1 rows with derived vectors in one shared Vectorize index; retrieval deliberately returns only the one or two most relevant memories per call (`docs/use/memory.md`, `src/mcp/memory/`).

- **Records:** subject, summary, body details, freeform category, status, optional `dedupe_key` and `source_uris`. Stored in D1; downloadable as JSON from `/account/memories`.
- **Capabilities** (domain `meta`): `metaMemoryVerify` (must be called before any write), `metaMemoryUpsert`, `metaMemoryDelete` (soft by default), `metaMemoryGet`, `metaMemorySearch`.
- **Auto-surface:** `search` retrieves from the query; `execute` retrieves when the agent passes `memoryContext`. Hits with the same `dedupe_key` collapse so duplicates cannot take both slots. Output is subject and summary only.
- **Conversation scope:** `conversationId` is server-issued and passed back by the client; it ties calls together for progressive disclosure but never hides memories from other agents of the same user.
- **Embeddings:** Workers AI embedding model (`memory-embed.ts`), reindexed by `memory-reindex.ts`.

**Vectorize layout** (ADR 0047, `src/vectorize/vector-namespaces.ts`). One index, `CAPABILITY_VECTOR_INDEX`, holds built-in capability vectors in a reserved `__kody_builtin__` namespace and every user's memory, job and package vectors in a namespace named by their `stable_user_id`. The namespace is the isolation boundary and a `userId` metadata filter is defence in depth. Vectors are derived from D1 and excluded from backups. Cloudflare caps an index at 50,000 namespaces, so the ADR accepts this layout only until 5,000 person accounts; the platform had 172 accounts at the 1 Sep 2026 launch audit.

## Email and inbox

Every account gets an inbox at `{username}@inbox.kody.codes` and sends only from that address, only to its own verified destinations; Kody is not an open relay (`docs/use/email-primitives.md`, `src/email/`, about 80 modules).

**Components**

| Component | Role |
| --- | --- |
| Origin `email` handler (`email/inbound.ts`) | Receives routed mail from Cloudflare Email Routing; resolves username; rejects unknown, unverified or suspended owners |
| Classification (`inbound-classification.ts`, `sender-rules.ts`, `auth-verdict.ts`) | Per-user block, quarantine or allow rules (200 cap), then DMARC/SPF/DKIM verdict → `accepted` or `quarantined` |
| `Mailbox` Durable Object (`mailbox-do.ts`, on `kody-platform`) | One per owner; SQLite store of parsed messages, delivery ledger, retention, tombstones |
| R2 `EMAIL_BLOBS` | Raw MIME and attachments (`email-raw-mime-store.ts`) |
| Outbound (`email/outbound.ts`) | Sends through the Cloudflare `EMAIL` binding from the platform address; re-checks verification, suspension and pause |
| Delivery events queue (`delivery-queue.ts`) | Consumes provider lifecycle events; updates delivery status; triggers automatic pause |
| Destinations (`destinations.ts`) | Up to 5 verified extra recipient addresses per user |
| System inboxes | Operator-owned `kody@`, `support@`, `abuse@`, `security@` and others on the apex, stored under the reserved `system:email` owner |

**Flow.** Accepted inbound mail is stored, then fans `email.message.received` to subscribed packages; quarantined mail fans `email.message.quarantined`. Payloads are metadata-first; handlers fetch bodies with `emailMessageGet`. Plus-addressing (`you+invoices@...`) routes to the base user and keeps the tag for filtering.

**Abuse controls.** Because all users share one sending domain and one egress, the platform bounds blast radius: daily send and receive entitlements, automatic outbound pause after one spam complaint or five bounces in a UTC day (`outbound-abuse.ts`), admin suspension enforced at every chokepoint, and a platform-wide `email_delivery_alert` lane.

**Transactional mail** (verification, reset, billing, usage nudges) comes from `kody@<apex>` with `Reply-To: support@<apex>`. Delivery status per message is tracked in `transactional_email_delivery_index`.

## Data storage map

Kody spreads state across seven Cloudflare storage products, chosen by a written rubric (ADR 0002): D1 for relational data, a per-user Durable Object for strongly consistent per-user state, KV for cached or ephemeral lookups, R2 for blobs, Vectorize for embeddings, Artifacts for git source, Analytics Engine for high-volume events. The full inventory, including export and deletion targets, is `docs/contributing/architecture/data-storage.md` (1,800 lines).

**D1 databases**

| Database | Binding | Owner worker | Contents |
| --- | --- | --- | --- |
| `kody` | `APP_DB` | origin, platform, runtime | All application tables; 71 migrations in `packages/worker/migrations/` from a squashed baseline |
| `kody-audit` | `AUDIT_DB` | origin, platform, runtime | `audit_events`: global hashed auth and security audit trail |
| `kody-jobs` | `JOBS_DB` | `kody-jobs` only | `jobs`, `archived_job_artifacts`; origin reaches it only through the `JOBS` service binding |

**`APP_DB` tables by area** (staging and `_next` migration tables omitted):

| Area | Tables |
| --- | --- |
| Identity and auth | `users`, `verifications`, `passkeys`, `oauth_connections`, `password_resets`, `email_verifications`, `pending_email_changes`, `user_email_claims`, `pending_email_claim_releases`, `username_redirects`, `invites`, `referrals`, `user_follows` |
| RBAC and delegation | `roles`, `permissions`, `role_permissions`, `user_roles`, `package_scope_grants`, `package_share_grants` |
| Packages and repos | `saved_packages`, `entity_sources`, `user_repos`, `repo_sessions`, `repo_session_due_owners`, `published_bundle_artifacts`, `package_kody_id_redirects`, `package_service_states`, `package_codemod_runs`, `package_codemod_run_items`, `entity_source_artifacts_push_subscriptions`, `saved_package_search_index_debt`, `agent_package_conversation_uses` |
| Community | `community_listings`, `community_forks`, `community_ratings`, `community_stars`, `community_reports`, `community_bans`, `community_activity_events` |
| Secrets and integrations | `secret_entries`, `secret_buckets`, `secret_provider_bindings`, `secret_provider_grants`, `user_oauth_apps`, `user_integrations`, `platform_oauth_apps`, `platform_provider_marks`, `user_openapi_bindings`, `user_openapi_binding_operations`, `user_mcp_oauth_clients` |
| MCP and memory | `mcp_server_settings`, `mcp_user_server_instructions`, `mcp_agent_sessions`, `mcp_memories`, `mcp_memory_conversation_suppressions`, `vector_embed_fingerprints` |
| Webhooks | `webhook_endpoints`, `webhook_apply_destination_grants`, `webhook_apply_destination_pending`, `package_invocation_tokens` (retiring) |
| Email | `email_inboxes`, `email_inbox_addresses`, `email_sender_identities`, `email_sender_rules`, `email_notification_destinations`, `pending_email_destination_verifications`, `email_outbound_provider_index`, `email_inbound_due_owners`, `email_user_graph_authority`, `transactional_email_delivery_index`, `email_delivery_alert_events`, `system_email_messages`, `system_email_threads`, `system_email_attachments`, `system_email_delivery_events`, `system_email_daily_counters`, `system_email_graph_authority` |
| Storage and values | `user_storage_buckets`, `value_buckets`, `value_entries` (retiring) |
| Billing and usage | `stripe_webhook_events`, `credit_wallets`, `credit_ledger_entries`, `credit_debit_cursor`, `credit_debit_progress`, `usage_rollups`, `fleet_execute_days`, `durable_object_duration_daily`, `durable_object_duration_coverage_daily`, `user_usage_campaigns`, `user_usage_campaign_sends`, `user_tips_email_opt_outs`, `d1_storage_reconcile_cursor`, `account_write_lease_repairs` |
| Platform | `feature_flags`, `feature_flag_user_overrides`, `feature_flag_exposure_rollups`, `site_banners`, `site_banner_dismissals`, `platform_feedback` |

**Durable Objects and how they are keyed** (`user-scoped-durable-object-name.ts`)

| Object | Worker | Id | State held |
| --- | --- | --- | --- |
| `JobManager` | jobs | `userId` | Next-due alarm |
| `RunLog` | runtime | `userId` | Run history, invocation ledger, workflow projections (90-day retention), job observability |
| `UserMeter` | platform | `userId` | Daily counters, storage-byte reservation, deletion tombstone, write leases |
| `Mailbox` | platform | `userId` | Parsed email, delivery ledger |
| `McpClientHub` | platform | `userId` | Remote MCP registrations and tokens |
| `RepoSessionIndex` | platform | `userId` | Session catalog, conversation resume |
| `StripePlanRefresh` | platform | `userId` | One-shot Stripe reconcile alarm |
| `StorageRunner` | runtime | `[userId, storageId]` | Package storage (SQLite) |
| `PackageRealtimeSession` | runtime | `{userId, packageId}` | App realtime state |
| `RepoSession` | platform | session id (documented exception; RPCs check owner) | Editing workspace |
| `MCP` | platform | MCP session id (owner checked each request) | Sessionful MCP lane |
| `OAuthPurgeCoordinator`, `KodyFetchGateway`, `StatusStore` | platform / status | singleton or per call | Coordination |

**KV.** `OAUTH_KV`: OAuth clients, grants and tokens (library-managed). `BUNDLE_ARTIFACTS_KV`: published bundles, package and job source snapshots, retriever caches, community snapshots, the reserved-username override, and encrypted refresh-family snapshots.

**R2.** `EMAIL_BLOBS` (raw MIME, attachments), `COMMUNITY_ASSETS` (icons, OG images, logos), `REPO_SESSION_BLOBS` (session workspace blobs), plus ops buckets `kody-production-backups` and `kody-nx-cache`.

**Analytics Engine datasets:** `kody_usage_events`, `kody_flag_exposures`, `kody_email_events`, `kody_mcp_protocol_events`, `kody_package_invoke_specifier_events`, `kody_execute_interpretable_events`, `kody_mcp_search_events`, `kody_onboarding_funnel_events`.

**Frozen contracts.** `data-storage.md` lists frozen key formats for D1 JSON columns, Durable Object ids, KV keys, R2 keys and Vectorize metadata. Any migration has to preserve or explicitly rewrite these.

## Observability and metering

Four separate records answer four questions: what ran for a user (run records), what it cost (usage events), who did something security-relevant (audit log), and is the platform up (status and Sentry).

| Layer | Store | Scope | Read surface | Code |
| --- | --- | --- | --- | --- |
| Run records | `RunLog` DO per user | Every execution attempt on 9 surfaces: `execute`, `export`, `subscription`, `app_fetch`, `app_realtime`, `job`, `workflow`, `retriever`, `webhook`; status, timings, truncated error, up to 200 log lines, soft triage | `/account/activity`, `runs` capabilities | `src/run-records/` |
| Usage events | Analytics Engine `kody_usage_events` + D1 `usage_rollups` | Per-user events at runtime chokepoints: duration, Cloudflare-measured CPU (via `DynamicWorkerUsageTail`), bytes, cache reuse, code size | Admin cohort views, `/account/usage`, credit debits | `src/usage/record-usage.ts` |
| Entitlement meters | `UserMeter` DO | Authoritative daily counters and storage bytes | Enforcement, `/account/usage` | `src/entitlements/` |
| Audit log | D1 `kody-audit` `audit_events` | Global hashed auth and security events, admin actions | `/admin/insights`, admin capabilities | `src/audit-log.ts` |
| Product telemetry | 7 other Analytics Engine datasets | MCP protocol lane, search quality, execute shape, package invoke specifiers, flag exposures, email events, onboarding funnel | Admin insights | `tools/ci/*-telemetry-config.ts` |
| Errors and traces | Sentry (per-worker `SENTRY_ENVIRONMENT`, sampled traces) | Platform exceptions; a rate-limited browser tunnel | Sentry | `sentry-options.ts`, `/sentry-tunnel` |
| Status | `kody-status` worker, `StatusStore` DO | Minute-by-minute probes of every product script; MCP execute health from real traffic, with an hourly synthetic fallback | `status.kody.codes` | `packages/status/` |

**Alert lanes** in the scheduled system (`auth_denial_alert`, `email_delivery_alert`, `email_verification_stall_alert`, `usage_entitlement_alert`) do not page anyone directly. They emit admin-only events (`auth.denial.burst`, `email.delivery.burst`, `fleet.entitlement.crossed`, `status.incident.opened`) that operator-owned packages subscribe to, so alerting is itself built on Kody packages.

**Platform feedback.** Users can approve attributed feedback for admin review (`platform_feedback`, a dispatch queue, `/admin/platform-feedback`); this is one of the four documented cross-user exceptions.

## Web app, admin and billing

The browser app is a Remix 3 (beta) server-rendered UI with a custom client router, served from origin; about 110 route handlers live in `packages/worker/src/app/handlers/` and client code in `packages/worker/client/`.

**Code layout.** `src/app/` holds server handlers and router; `client/` holds browser components and route loaders; `universal/` holds code shared by both (route table, permissions registry, feature-flag registry, onboarding process). Import boundaries between app, MCP, worker and universal layers are enforced by lint (`docs/contributing/import-boundaries.md`).

**User-facing surfaces**

| Group | Routes |
| --- | --- |
| Marketing and docs | `/`, `/pricing`, `/blog`, `/docs/:slug`, `/faq`, `/support`, `/privacy`, `/terms`, agent-discovery files |
| Auth | `/login`, `/signup`, `/verify`, `/verify-email`, `/reset-password`, `/pending-verification`, `/auth/:provider`, WebAuthn endpoints |
| Onboarding | `/onboarding` (connect-your-agent wizard, derived checklist), `/discord` |
| Account | `/account` plus `activity`, `billing`, `credits`, `connected-agents`, `connections`, `email`, `experiments`, `export`, `integrations`, `jobs`, `mcp-oauth-clients`, `mcp-servers`, `memories`, `packages`, `passkeys`, `password`, `profile`, `secret-providers`, `secrets`, `shared`, `two-factor`, `usage`, `values`, `waiting`, `webhooks`, `workflows` |
| Approvals | `/connect/oauth`, `/connect/secrets` (host approval), `/connect/webhook-apply`, package share and publish approvals |
| Packages and community | `/@username`, `/@username/:name` with `/tree/:ref` and `/settings`, `/community`, `/community/:id` |
| Admin (role `admin`) | `/admin/users`, `roles`, `insights`, `feature-flags`, `banners`, `codemods`, `community-reports`, `platform-feedback`, `platform-integrations`, `provider-marks`, `reserved-usernames`, `system-email`, `user-credits` |

**Approval pattern.** Actions that widen what code can do, such as approving a secret host, applying a webhook to a provider or accepting a share, require a human click in the signed-in browser UI. An agent can request them over MCP but cannot complete them.

**Billing** (`src/billing/`). Stripe is called with raw `fetch` (no SDK); without `STRIPE_SECRET_KEY` the app runs on manual plans only. Checkout needs a signed-in session. Plan state syncs from Stripe webhooks (`/stripe-webhook`, deduped in `stripe_webhook_events`) with a per-user `StripePlanRefresh` alarm as backstop. Prepaid credits (`credit_wallets`, `credit_ledger_entries`) debit against Dynamic Worker days and Durable Object rows read, with optional auto top-up. Kit (email marketing) tags are synced best-effort.

**Other integrations on the web side:** Discord (guild join and plan roles on social login), YouTube watch overlay, and OG image generation through the Cloudflare `IMAGES` binding.

## Build, test and operations

The repo is an Nx 23 monorepo on npm workspaces, TypeScript 6 and Node 26, with `npm run validate` as the single local gate and GitHub Actions deploying the fleet in a fixed order.

**Workspace packages:** `worker` (origin plus the platform and runtime entrypoints), `platform-worker`, `runtime-worker`, `jobs-worker`, `highlight-worker` (wrangler configs and thin entries), `shared` (`@kody-internal/shared`: password hashing, D1 retry, scheduled lanes, backup manifests), `status`, `nx-cache`, `backup-control-plane`, and `mock-servers/cloudflare`.

**Tooling:** Vite bundler, oxlint and oxfmt, knip for unused code, Vitest in three pools (node, workers, MCP end-to-end) plus Playwright end-to-end, Wrangler, and a self-hosted Nx remote cache on R2 shared by CI and coding agents (ADRs 0019, 0038–0040).

**`npm run validate` runs:** format and lint, typecheck, node and workers unit tests, MCP end-to-end tests, Playwright, dry-run builds of each worker, startup-time and bundle checks, primitives-map check, migration checks, deploy guardrails, docs temporal-language and decision-number checks, Mermaid syntax, lockfile peer drift, a "slop ratchet" (file-size ratchet plus decorative-banner check) and knip.

**CI workflows** (`.github/workflows/`): `validate`, `preview` (per-PR preview deploy with generated resources), `deploy`, `dr-escrow`, `nx-cache-deploy`, `publish-mcp-registry`, `cla`, `merge-conflicts`, `weekly-site-perf`.

**Production deploy order** (`deploy.yml`, concurrency group never cancelled mid-run):

1. `kody-jobs` and `kody-highlight` in parallel.
2. Apply `APP_DB` and `AUDIT_DB` migrations (forward-only).
3. Upload `kody-platform`, then `kody-runtime`, then origin.
4. Health checks and the origin execute smoke.

Resource creation is code: `tools/ci/production-resources.ts` and `preview-resources.ts` ensure D1, KV, R2 and queues exist and generate wrangler configs. Durable Object class changes are guarded by `durable-object-baseline.json` and a deletion allowlist.

**Rollback** (`docs/contributing/rollback.md`): Path A is a Cloudflare version rollback in a set order; Path B is forward-fix on `main`. Path A is unsafe when a D1 or Durable Object migration shipped.

**Disaster recovery** (`disaster-recovery.md`): the `kody-production-d1-backups` worker runs D1 backup, seal-day and restore Workflows into an object-locked R2 bucket with Ed25519-signed manifests. Its admin UI sits behind Cloudflare Access. Restores follow prepare, typed confirmation and a drill before any production restore. Edge maintenance mode is a script. The runbook is written for one operator.

**Local development:** `npm run dev` starts a custom CLI (`cli.ts`) that runs origin, platform, runtime, jobs and highlight in one Miniflare with a mock Cloudflare API worker, on port 3742 or the next free port. Seed users are `kody@example.com` (admin) and `jane@example.com`. Coding agents get repo-local skills in `.agents/skills/`: `control-kody`, `ship-pr`, `orchestrate`, `conduct`, `preview-manual-test`, `visual-recap`, `remix`, `review-and-recommend`, `file-friction`, `testing-multi-worker-dev`, `cleanup-after-migrations`.

**Contribution rules:** external PRs need a signed inbound CLA (ADR 0018); friction is filed through Kody packages, not raw GitHub issues.

## Decision records that constrain change

The 51 decision records in `docs/contributing/decisions/` act as a veto list: `AGENTS.md` tells contributors to check them before proposing any new primitive or surface. A migration will have to supersede some of them explicitly.

| Area | Record | Decision |
| --- | --- | --- |
| Topology | 0016 | Split the mono-worker; untrusted-code execution and scheduling live outside origin's failure domain |
| Topology | 0034 | Origin owns no Durable Object classes |
| Topology | 0004 | Status page is a separate worker |
| Topology | 0017 | Hosted package apps on per-user subdomains of a separate apex |
| Data | 0002 | Placement rubric across D1, per-user Durable Object and Analytics Engine |
| Data | 0047 | One Vectorize index, per-user namespaces, until 5,000 users |
| Data | 0020 | Repo-session workspaces use `@cloudflare/shell` with R2 spill, not a VM |
| MCP | 0005 | Dual MCP lanes now, stateless-only later |
| MCP | 0015 | Wait on the MCP Skills extension; skill-shaped content goes through search |
| MCP | 0023, 0024, 0045 | Progressive search disclosure; packages outrank synthesized providers; guides load through search |
| MCP | 0033 (no-user-as-conversation) | Never key conversation state on user or transport session |
| MCP | 0033 (memory-auto-surface-lab) | Memory auto-surface is a tuned, compact lab feature |
| Auth | 0049 | No per-capability OAuth scopes |
| Auth | 0042 | Capabilities never take secrets as inputs |
| Auth | 0029, 0030 | Discord social login, guild join and roles |
| Packages | 0001 | No package versioning or pinning; git history is the history |
| Packages | 0003 | Repos are the base primitive; packages are an extension |
| Packages | 0006 | No repo CI primitive |
| Packages | 0021 | Publish-gated composition; no hot-patching |
| Packages | 0025 | No long-running services primitive; daemons run elsewhere |
| Packages | 0031, 0037 | Dependency wildcard map; no `packages.invoke` for authors |
| Packages | 0014, 0035, 0036 | Platform packages resolve live, execute-only, fork-only |
| Packages | 0043, 0046, 0050 | Visibility is a repo setting; community is the catalog; share grants are not scope grants |
| Triggers | 0026, 0027, 0048 | Invocation tokens are retired in favour of webhooks |
| Triggers | 0032 | No jobs without a package |
| Triggers | 0013 | Synthetic package requests run real surfaces |
| Platform | 0007 | Keep in-house feature flags |
| Platform | 0008 | Decline span-level tracing and other lifecycle primitives |
| Platform | 0022 | Retire the values primitive |
| Platform | 0041 | Platform emits events; packages own operator reactions |
| Billing | 0051 | Pro billing is include, then credits, then stop |
| UI and code | 0009, 0010, 0012, 0028 | Shiki highlighting; record-table layout; universal layer; list-detail expand |
| Repo ops | 0011, 0018, 0019, 0038–0040, 0044 | Test pool harness; inbound CLA; self-hosted Nx cache and its write rules; retired brand domains |

The project-intent document adds three standing non-goals that are not ADRs: per-organization tenancy, delegation between many people in one account, and enterprise SSO or directory provisioning.

## Enterprise pressure points

The biggest gap is that the unit of everything is one person: there is no organization entity anywhere in the schema, the Durable Object naming or the vector namespaces. These are observations to feed the target-architecture work, not a plan.

| Area | Current state | Why it matters for enterprise | Where it lives |
| --- | --- | --- | --- |
| Tenancy | Every row, DO id, vector namespace, KV key and R2 prefix is keyed by `userId`; per-org tenancy is an explicit non-goal | A tenant (org) dimension has to be threaded through every storage layer and every frozen key contract | `data-storage.md` frozen contracts, `user-scoped-durable-object-name.ts`, ADR 0047 |
| Identity key | `stable_user_id` is SHA-256 of the signup email; usernames drive the inbox address, `@username` URLs and `{user}.kody.run` | Corporate email changes, name collisions across orgs, and IdP-issued subjects do not fit this model | `authentication.md`, `identity/` |
| Sign-in | Password, TOTP, passkeys, GitHub/Google/X/Discord; open signup | No SAML or enterprise OIDC relying-party login, no SCIM provisioning or deprovisioning, no org-enforced MFA | `app/oauth-providers.ts`, `project-intent.md` |
| Authorization | RBAC covers only `user` and `role` entities with `own`/`any`; `admin` means platform operator | No org admin, no team roles, no resource-level permissions on packages, secrets or memories | `universal/permissions.ts`, `authorization.md` |
| Sharing | Fork, per-package share to paid accounts, platform scope grants | No shared team workspace, shared secrets or shared memory | `package_share_grants`, `package_scope_grants`, ADR 0050 |
| Token scope | MCP tokens carry only OIDC scopes; a token can do anything the user can | Least-privilege agent tokens and admin-controlled client allowlists are common enterprise asks | ADR 0049, `mcp-oauth-scopes.ts` |
| Secrets encryption | One platform key `SECRET_STORE_KEY`, escrowed by a solo operator | Per-tenant keys, customer-managed keys and HSM/KMS integration | `mcp/secrets/`, `secret-rotation.md` |
| Shared egress and email | All users share one sending domain and one egress path | Custom domains per org, egress IP allowlisting, org DLP on outbound mail and fetch | `email/`, `fetch-gateway.ts` |
| Plans and billing | Per-user Stripe plans and per-user quotas in `UserMeter` | Org-level contracts, pooled quotas and seat billing | `entitlements/`, `billing/` |
| Audit and observability | Hashed global audit DB, per-user `RunLog`, Sentry, Analytics Engine | Org-scoped audit export, SIEM streaming, retention policies per tenant | `audit-log.ts`, `run-records.md` |
| Change control | No package versioning (0001), no CI primitive (0006), agents publish directly once checks pass | Approval workflows, promotion between environments, signed releases | ADRs 0001, 0006, 0021 |
| Catalog | Public community catalog on the same platform | Private org catalog, allowlisted packages, blocked public forks | `community-packages.md`, ADR 0046 |
| Scale limits | One Vectorize index capped at 50,000 namespaces (ADR accepts up to 5,000 users); single `APP_DB` D1 database | Tenant sharding, larger D1 footprint, data residency by region | ADR 0047, `wrangler.jsonc` |
| Platform coupling | Deep use of Cloudflare-only primitives: Worker Loader, Durable Objects, Workflows, Artifacts, Vectorize, Email Routing | Enterprises may require private cloud or on-prem; porting means replacing the sandbox, actor model and git store | `packages/*/wrangler.jsonc` |
| Operations | Runbooks written for one operator; first admin set by SQL | On-call rotations, separation of duties, formal DR evidence | `disaster-recovery.md`, `rollback.md` |

**Strengths worth keeping.** Strict isolation enforced at every layer, a sandbox with no route to secrets, deny-by-default egress, fail-closed chokepoints, idempotent run ledgers and a well-documented storage inventory give the migration a solid base. Most of the work is adding a tenant layer above the user, not replacing what is there.

**License.** Kody is under FSL-1.1-ALv2, which allows internal use and modification but not a "Competing Use" that substitutes for Kody; each version becomes Apache 2.0 after two years. How that applies to an enterprise fork depends on how it will be offered, so it is worth a legal review before committing (this is not legal advice).
