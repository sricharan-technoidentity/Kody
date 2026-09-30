# Kody repo review (context handoff for another agent)

Source: `kody/docs/` (219 files, ~4.4 MB) plus repo layout, `package.json`, `nx.json`. Built from three parallel doc sweeps. Not every file was read line by line (see "Coverage gaps"). The repo root is `/home/adminti/Downloads/Kody/Kody/kody`. It is not a git repo here.


## 1. What Kody is
- A multi-user personal assistant platform on Cloudflare Workers, reached from any MCP-capable agent host (Claude, ChatGPT, Cursor, Codex and others). It has no chat UI and no model loop of its own.
- Its value is durable state that outlives the conversation and runs with no model in the loop:
  - shared memory
  - secrets an agent can use but never read
  - saved code packages
  - jobs, workflows and webhooks
  - integrations and remote MCP servers
  - a per-user email inbox (`{username}@inbox.kody.codes`)
- The MCP surface is only two tools: `search` (discovery, returns markdown) and `execute` (runs one sandboxed ES module). The capability graph lives in code, and adding a tool per capability is rejected.
- **Hard invariant: per-user isolation.**
  - D1 rows are scoped by `userId`.
  - Durable Object ids are user-namespaced.
  - Vectorize namespaces are per user.
  - Any path without a `userId` is a bug.
  - Four documented cross-user exceptions:
    1. RBAC account admin (`any` access on `user` and `role` only).
    2. Operator-owned system email.
    3. Attributed platform feedback, after user approval.
    4. Role-gated metadata on public community listings.
- Non-goals: org tenancy or team workspaces, enterprise SSO, a large static tool catalog, a starter kit.
- Never key state on "the user" or "the MCP session" as if it were the conversation (ADR 0033).
- License: Fair Source (FSL-1.1-ALv2). Inbound contributions need a CLA (ADR 0018).
- Owner and operator: Kent C. Dodds, effectively a solo operator.

## 2. Production topology

| Script | Surface | Owns |
|---|---|---|
| `kody-production` (origin, `packages/worker`) | `kody.codes` | Remix UI and SSR, MCP HTTP, OAuth, inbound email, webhook ingress, queue consumers, `JobsHost`. **Zero Durable Objects** (ADR 0034). |
| `kody-platform` | health only | DOs: `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`, plus `KodyFetchGateway` |
| `kody-runtime` | `{user}.kody.run` | DOs: `StorageRunner`, `RunLog`, `PackageRealtimeSession`; Workflow `DynamicCallableWorkflow`; package-app bridge |
| `kody-jobs` | none | `JobManager` DO, `JOBS_DB` (D1), 5-minute cron, `kody-scheduled-dispatch` queue |
| `kody-highlight` | none | Shiki tokenizer |
| `kody-status` | `status.kody.codes` | `StatusStore` DO, external probes, no `APP_DB` access |
| `kody-nx-cache` | `nx-cache.kody.codes` | R2-backed Nx cache |
| `kody-production-d1-backups` | operator-only | D1 backup and DR workflows |

- **Bindings:**
  - D1: `APP_DB`, `AUDIT_DB`, `JOBS_DB`.
  - KV: `OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`.
  - R2: `EMAIL_BLOBS`, `REPO_SESSION_BLOBS`, `COMMUNITY_ASSETS`.
  - Vectorize: `CAPABILITY_VECTOR_INDEX` (one index, per-user namespaces until about 5k users, ADR 0047).
  - Queues: scheduled dispatch, webhook dispatch, email delivery, package events, platform feedback, community activity, listing published.
  - Analytics Engine: `USAGE_EVENTS` and others.
  - Also Workers AI and Worker Loader for dynamic isolates.
- **Local dev:** `npm run dev` runs all five product scripts in one Miniflare. Playwright (`CLOUDFLARE_ENV=test`) runs everything on a single `kody-test` script.
- **Deploy** (`.github/workflows/deploy.yml`):
  - Jobs and highlight go first.
  - Then D1 migrations, then platform, then runtime, then origin.
  - Then health checks.
  - Never cancel a deploy mid-sequence.
  - UI-only changes upload origin only. Guide markdown uploads origin and platform.
- **MCP execute health:** `execute` resolves `KodyFetchGateway` on `kody-platform`. The origin `execute-smoke` endpoint does not prove MCP health. A heartbeat from real execute completions feeds the status page.

## 3. Request lifecycle (origin)
1. Canonical-host check.
2. Package-app host isolation. The `kody.run` apex serves nothing, and each subdomain serves only its own `/packages/{id}/*`.
3. OAuth and OIDC metadata.
4. `/mcp`. Two lanes share one registration: the sessionful `MCP` DO (2025 protocol) and the stateless per-request lane (2026-07-28 protocol). The legacy lane retires by metrics, not by date (ADR 0005).
5. `@username` ingress: webhooks and the invocation-token drain.
6. Static assets.
7. The Remix handler (`app/handler.ts`, routes in `universal/routes.ts`).
- Anonymous marketing HTML is CDN-cached for 60 seconds. Per-request memoization uses `AsyncLocalStorage`, with `Server-Timing` headers.
- Sentry on the Worker and the `MCP` DO. `UserCodeError` is filtered out.

## 4. Auth and authorization
- **Browser session:**
  - Stateless `kody_session` cookie signed with `COOKIE_SECRET`, valid 7 days (30 with remember-me).
  - "Log out everywhere" means a password change. It stamps `password_changed_at` and revokes all MCP grants.
  - The cookie carries `stable_user_id` (a hash of the signup email), never `users.id`.
- **Sign-in options:** password (minimum 8 characters), TOTP, passkeys, and social login (GitHub, Google, X, Discord).
- **Email verification** is required for OAuth authorize, `/mcp`, sending mail and inbound mail. Unverified person accounts are purged after 7 days.
- **MCP OAuth** uses `@cloudflare/workers-oauth-provider`:
  - OAuth 2.1 and OIDC, PKCE with S256 only, RS256 ID tokens.
  - Client identification through CIMD, open DCR (an accepted residual), and user-minted clients.
  - Access tokens last 1 hour, and refresh tokens do not expire.
  - **No capability scopes** (ADR 0049). Connecting an agent is one full grant.
- **Package apps** use a 60-second single-use handoff token, then a `__Host-kody_pkg_session` cookie.
- **RBAC:**
  - Permission strings are `action:entity:access`. Entities are `user` and `role` only. Roles are `user` and `admin`.
  - Roles load fresh on every request and fail closed.
  - Admins see only identity, plan and activation metadata, never user content.
- **Platform accounts** (`account_type='platform'`) own official scopes such as `@kody` and never log in.
  - `package_scope_grants` let admin-approved persons act inside such a scope.
  - `package_share_grants` are person-to-person invites and are separate (ADR 0050).
- **Account deletion** needs the phrase `GOODBYE KODY`. It runs an inventory-driven cascade and sets `deleting_at` first, which fences writes.

## 5. Product model (what users and agents see)
- **Packages:**
  - A package is a repo with runtime surfaces activated (ADR 0003). Identity is `@username/leaf`.
  - `package.json#kody` holds these fields: `description`, `tags`, `dependencies` (a name-to-`*` map, ADR 0031), `secretMounts`, `app`, `subscriptions`, `emits`, `webhooks`, `jobs`, `retrievers`.
  - Publishing requires a non-empty `README.md` (with `## Intent`) and `AGENTS.md`, plus JSDoc on every export.
  - **No versioning** (ADR 0001). Git is the history. Static `kody:@scope/pkg/export` imports are pinned into bundles at publish, and literal dynamic imports are rejected.
  - Private by default. The publish lock can be set by agents but only the owner can unlock, on the website.
  - Two authoring lanes: a git lane for coding agents, and a tool-only lane through repo sessions (`repoOpenSession`, `repoEditFiles`, `repoCommit`, `repoPublishSession`).
- **Package apps:** Worker fetch handlers hosted at `{user}.kody.run/packages/<name>`.
- **Jobs** (recurring, declared in `kody.jobs`), **workflows** (one-off or delayed, about 4.5 minutes), **webhooks** (one name per export, minted URL as credential, HMAC verification optional), and **subscriptions** to platform events (`email.message.received`, `run.error.recorded`, `repo.pushed` and others).
- **Secrets:**
  - There is no `secret_get`.
  - `{{secret:name}}` placeholders resolve only at the secret-aware `fetch` boundary.
  - Two independent, owner-only, website-only approvals: the host allowlist (`/connect/secrets`) and the package grant.
  - Capability inputs can never carry secrets (ADR 0042).
  - Optional external secret providers such as 1Password, behind the `secret-providers` flag.
- **Integrations:** bring-your-own OAuth apps. Tokens are AES-GCM encrypted on the connection row and refreshed host-side. The rule is to connect, smoke-test in `execute`, then build. `integrationLock` restricts a connection to specific packages (tighten-only).
- **MCP client servers:** Kody dials out to remote MCP servers through the `McpClientHub` DO. Tools appear as `kody.mcp["name"].tool()`. Home or LAN servers are reached through Cloudflare Tunnel.
- **Memory:** durable facts shared across agents. Writes follow verify first, then upsert. The top one or two memories are auto-surfaced.
- **Email:** verified-destination sending only, replies limited to addresses from stored inbound mail, and abuse pauses.
- **Community:** public packages are forked (`communityFork`) into an inert copy the owner must review and adopt. The catalog is the community (ADR 0046).
- **Sharing:** paid-plan, invite plus accept, `use` role only, pinned or following. Prefer forks.
- **Waiting** (`/account/waiting`) lists human-only gates. **Activity** (`/account/activity`) shows run records.
- **Privacy:** admins cannot see secrets, memories, private packages, jobs, email or storage.
- **Agent-side rule:** confirm mutating calls to GitHub, Cloudflare and similar services (not platform-enforced).
- **Guidance layers:** MCP instructions, package README and AGENTS.md, export JSDoc, memories. Put guidance in the lowest layer that reaches the agents who need it.

## 6. Data and metering
- **Placement rule (ADR 0002):**
  - D1 for data found by something other than the owner's id, cross-entity invariants and config.
  - A per-user DO for high-write, owner-addressed data (`UserMeter`, `Mailbox`, `RunLog`, `StorageRunner`, `RepoSession*`).
  - Analytics Engine for events.
- **Frozen strings:** DO names (`idFromName(userId)` or JSON arrays), KV key prefixes and R2 key prefixes. Do not change them.
- **Package source:** Artifacts git repos are canonical. D1 `entity_sources` is a projection. Published snapshots and bundles live in KV.
- **Run records** (`RunLog` DO): about 30 days, 2,000 runs per user. Invariant: state is never derived from history.
- **Usage metering:**
  - `recordUsage` writes to Analytics Engine, never per-event D1 (`no-per-event-shared-writes`).
  - `usage_rollups` is recomputed hourly.
- **Scheduled lanes:** the jobs worker's 5-minute cron enqueues lanes (retention, aggregation, purge, reconciliation and others). Origin has no cron.
- **Plans:** `free`, `standard`, `pro`, `max` (manual only).
  - Public ladder: Free is hard-capped. Pro is $12/month or $120/year.
  - Pro follows include, then prepaid credits, then stop (ADR 0051). Nobody is invoiced for overage.
  - Enforcement uses `assertWithinEntitlement`, with counters in `UserMeter`.
  - Overlays: a 14-day gift when a second agent ecosystem connects, and referral credit.
- **Feature flags:** the code registry owns existence, and D1 holds state and per-user overrides. Precedence is user override, then global row, then registry default. Evaluation fails closed.
- **Startup budget:** module evaluation must stay fast. Domains load lazily, heavy libraries load on first use, and `worker-startup-time:check` budgets are origin 280 ms, platform 340 ms, runtime 160 ms.

## 7. Repo layout and tooling
- **Layout:** `packages/{worker, platform-worker, runtime-worker, jobs-worker, highlight-worker, status, nx-cache, backup-control-plane, mock-servers, shared}`, plus `tools/`, `e2e/`, `docs/` and `.agents/skills/`.
  - `platform-worker` and `runtime-worker` are mostly wrangler config. Their entry code lives in `packages/worker/src`.
  - `packages/shared` holds pure cross-worker helpers.
- **Stack:** Node 26 and npm, TypeScript 6, Remix 3 on Vite (`@cloudflare/vite-plugin`), Nx 23 with a self-hosted R2 remote cache, oxlint (plus a local `kody-custom/*` plugin), oxfmt, knip, Vitest (node, workers pool, mcp-e2e) and Playwright.
- **Import layers** (`import-boundaries.md`), downward only:
  1. `#app/*`
  2. `#mcp/*`
  3. shared `#worker/*`
  4. `#universal/*` (client-safe)
  - `#client/*` may import only universal and client code.
  - Lint enforces this, and the allowlist freezes existing edges (each entry needs a reason).
- **`npm run validate`** is the single authoritative local gate. It is read-only, runs about 27 parallel legs with `CI=1`, and passing it means CI passes.
  - Husky pre-commit runs oxfmt, oxlint and, for non-docs diffs, typecheck and the migrations check.
  - Pre-push runs `test:push`.
- **Testing style:**
  - Prefer `*.node.test.ts` (in-memory `node:sqlite` D1). Use `*.workers.test.ts` only when binding fidelity matters.
  - The `mcp-e2e` suite is a tiny smoke set only.
  - Tests are flat, with no `describe` and no `beforeEach`.
  - Reject tautological, copy-pinning and lone-absence assertions.
  - Unexpected `console.error` or `console.warn` fails a test.
- **Code style:** function declarations, `Array<T>`, `type` over `interface`, named exports, `#` imports. No `any`, no `TODO` or `FIXME`, and a file-size ratchet.
- **Migrations:** `packages/worker/migrations/NNNN-*.sql`, forward-only. The append-only `tools/migration-ledger.json` records SHA-256 hashes. Never edit a migration that has landed on `main`. History was squashed on 2026-08-04.
- **Deploy guardrails** (`deploy-guardrails:check`): a DO-class baseline and allowlist, no `deleted_classes` on transferred classes, no destructive Cloudflare CLI in automatic workflows, and a preview-name guard on every delete.
- **PR previews:** per-PR worker sets `kody-pr-<n>-*` with seeded data.
- **Ops:**
  - Rollback: a Cloudflare version rollback is unsafe when the deploy included DO or D1 migrations or rotated secrets. Then it is a forward fix.
  - DR: signed manifests, a separate account, and drills. The doc describes a "designed end state", and lanes count as unproven until they have a live-evidence log entry.
  - Secret rotation: rotating `SECRET_STORE_KEY` bricks stored secrets without a re-encryption migration.
- **Agent tooling:**
  - `control-kody` CLI (`npm run control-kody -- ...`) with a Feature Map that must be updated with any user-facing route change.
  - Friction log (GitHub issues with the `friction` label, filed only through the Kody packages).
  - Skills in `.agents/skills`: `ship-pr`, `conduct`, `orchestrate`, `remix`, `preview-manual-test` and others.
- **Docs rules:**
  - `docs/use` is for users and `docs/contributing` is for developers.
  - Write in the present tense. `docs:check-temporal` enforces this.
  - Prefer checkers over should-lists.
  - Open `docs/contributing/decisions/index.md` before proposing a new primitive.
  - `AGENTS.md` is a small index that points to focused docs.

## 8. Decision records (steering veto list, `docs/contributing/decisions/`)
Read the index first. Highlights:
- **0001** no package versioning.
- **0003** repos as the base primitive.
- **0006** no repo CI primitive.
- **0007** in-house feature flags.
- **0021** publish-gated packages, with no HMR.
- **0022** values primitive retired.
- **0025** no package services or daemons.
- **0032** no unattached jobs.
- **0034** origin owns no DOs.
- **0036** person accounts cannot run official platform packages, so they fork first.
- **0037** no author-facing `packages.invoke`.
- **0041** no hardcoded operator correspondence.
- **0042** no capability-input secrets.
- **0043** repo visibility is the share switch.
- **0046** the community is the catalog.
- **0048** inbound HTTP is webhooks, and invocation tokens drain.
- **0049** no capability OAuth scopes.
- **0050** share grants are not scope grants.
- **0051** Pro is include, then credits, then stop.

## 9. Security audit (2026-09-16, no Critical findings)
- **High:**
  - H1: `communityForkAdopt` was reachable from package runtimes (fixed, with a residual for imported code inside an interactive `execute`).
  - H2: the sandbox secret-authority runner is reachable through well-known symbols (same-user bypass).
  - H3: `StorageRunner` SQL has no row cap.
- **Medium:** package runtimes inherit most capabilities (candidates for `directMcpOnly`), private and raw-IP hosts are accepted in host approval, inbound mail auth fails open, Mailbox list queries are heavy, two startup-budget violations (`isomorphic-git`, `marked`), and five accessibility items.
- **Accepted residuals (do not relitigate):** open DCR, no CSRF tokens, stateless cookies, no step-up for secret reveal, PBKDF2 at 100k iterations, no SSRF denylist on non-secret sandbox fetch, and opt-in webhook HMAC.

## 10. Doc inconsistencies and gotchas noticed
- Pricing text is inconsistent across docs about which tier costs $12 (Standard versus Pro). Treat the entitlements doc and `kody.codes/pricing` as authoritative.
- Connection management is described as `/account` in one doc and `/account/connections` in another.
- The package-unlock URL differs between docs (`/@u/pkg` versus `/@u/pkg/settings`).
- Two ADR files are numbered 0033. The `-lab` suffix is the allowed exception.
- `checks.md` may not list every `validate` leg. Trust `package.json`.
- Some features sit behind flags or experiments (`secret-providers`, `package-share-grants`, `jev-search-rerank`, `execute-invoke`), so docs can describe capabilities a given user cannot see.
- Legacy drains still exist: values, invocation tokens, and platform OAuth apps. Removal is gated on zero leftovers.

## 11. Coverage gaps (not read in full)
`security.md`, `operator-accounts.md`, `environment-variables.md`, `setup-manifest.md`, `disaster-recovery.md`, `adding-capabilities.md`, `community-packages.md`, `package-codemods.md`, `mcp-server-patterns.md`, most ADR bodies (title and decision only), the account-deletion and export inventories, and every guide beyond its key sections. **No source code under `packages/` was read.** Claims about code paths come from the docs and may have drifted.

## Where to look next (by task)
- New capability: `contributing/adding-capabilities.md`, `secret-host-approval.md`.
- New package feature: `packages-and-manifests.md`.
- New data: `architecture/data-storage.md`, ADR 0002.
- New surface or primitive: the decisions index, then `architecture/primitives.yaml`.
- Deploy or rollback: `setup/preview-deploys.md`, `rollback.md`, `disaster-recovery.md`.
- Security-sensitive change: `contributing/security.md`, the audit, and `architecture/authorization.md`.
