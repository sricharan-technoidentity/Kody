# Checks

`npm run validate` and the test commands. See the [setup index](./index.md)
for the other setup pages.

- No git hooks are installed; nothing runs on `git commit` or `git push`.
  Formatting and linting are explicit commands: `npm run format` /
  `npm run format:check` (oxfmt) and `npm run lint` / `npm run lint:fix`
  (oxlint).
- `npm run validate` is the single authoritative local gate. It is read-only and
  executes `format:check`, `lint`, `typecheck`, `backup:build`, `status:build`,
  `nx-cache:build`, `jobs:build`, `runtime:build`, `platform:build`,
  `primitives:check`, `migrations:check`, `deploy-guardrails:check`,
  `docs:check-temporal`, `docs:check-decisions`, `mermaid:check`, `audit:prod`,
  and `lockfile:check` in parallel, reporting every failure (sibling checks are
  not aborted on the first failure, including when one of the docs or mermaid
  checks fails). Tests are not part of `validate` — run them manually when you
  want them (see the test commands below). Trusted writers (Cloud Agent
  environments) can set `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and the write
  token so Nx uploads task artifacts to `https://nx-cache.kody.codes` (see
  [decision 0019](../decisions/0019-self-hosted-nx-remote-cache.md),
  [decision 0038](../decisions/0038-no-nx-cloud-read-write-cache-tokens.md),
  [decision 0040](../decisions/0040-same-repo-writers-may-put-nx-cache.md), and
  [`packages/nx-cache/readme.md`](../../../packages/nx-cache/readme.md)). Those
  cached scripts run through `tools/run-nx.ts` so a mid-run remote-cache
  transport flake cannot fail validate after the tasks already succeeded.
- `npm run lockfile:check` fails when a locked direct dependency sits inside its
  declared range but outside a peer range that range can still reach.
  `npm install` rewrites `package-lock.json` for that drift (including an
  optional peer). The check keeps a Cloud Agent environment install from leaving
  a dirty lockfile on a fresh checkout.
- `npm run deploy-guardrails:check` protects reviewed Durable Object migration
  history and bindings in both Wrangler configs, requires exact allowlisting for
  class deletion, and — when a `.github/workflows` directory exists — rejects
  destructive Cloudflare CLI operations in automatically triggered jobs.
- `npm run validate:fix` runs `format` + `lint:fix` and is the explicit opt-in
  for mutating auto-fixes. It is never required to pass `validate`.
- `npm run format` applies formatting updates on its own.
- Tests are manual and optional — nothing runs them automatically:
  - `npm run test` — worker suite via Nx
  - `npm run test:node` / `npm run test:workers` — the two unit-test suites
  - `npm run test:push` — `test:node` + `test:workers` together with `CI=1`
  - `npm run test:e2e:run` — Playwright E2E
  - `npm run test:mcp` — MCP server E2E
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts, so `npm run validate` self-heals on a fresh machine.
- Use `npm run test:e2e:install` when you want to prefetch Playwright browsers
  ahead of time instead of waiting for the first E2E run. On Cloud Agent Linux,
  `test:e2e:ensure` (the same script `test:e2e:install` runs) uses native
  `unzip` because `playwright install` hangs on that kernel. Other machines
  still run `playwright install` (`--with-deps` is local-only). CI caches
  `~/.cache/ms-playwright` and runs `test:e2e:ensure`, so a lockfile-matching
  cache hit skips the download and never runs `apt-get` (`apt-get update` can
  hang the E2E job past the 15-minute timeout).
- `npm run test:e2e:run` runs the Playwright suite through Nx and depends on a
  cached `worker:prepare-e2e-env` target for `.env` bootstrap plus an uncached
  `worker:prepare-playwright` target that checks the local Chromium install.
- `npm run test:mcp` runs MCP server E2E tests and also depends on the cached
  `worker:prepare-e2e-env` target, which writes `packages/worker/.env` from
  `.env.example` when needed and backfills `COOKIE_SECRET` before the test run.
