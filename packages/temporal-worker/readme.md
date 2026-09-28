# Kody Temporal worker

This package runs Kody's deterministic Temporal workflows and their Node
Activities. Temporal owns timers, retries, cancellation, and schedule dispatch;
user-authored package code still executes in the Cloudflare sandbox through the
signed Activity Gateway.

The process starts two pollers:

- `TEMPORAL_TASK_QUEUE` (default `kody-foundation`) runs workflows and the
  lightweight claim, resolve, finalize, and Stripe plan refresh Activities.
- `kody-package-activities` runs package-execution Activities with independent
  concurrency through `TEMPORAL_PACKAGE_ACTIVITY_MAX_CONCURRENT_EXECUTIONS`.

Both pollers use pinned Worker Versioning under deployment
`kody-temporal-worker`. `KODY_TEMPORAL_BUILD_ID` identifies the build; local
development defaults to `development`.

## Local development

Start a Temporal development server first, then use separate terminals from the
repository root:

```sh
npm run temporal:dev
npm run temporal:local:set-current
```

Run `temporal:local:set-current` after the worker registers its build. The
helper refuses production mode and non-loopback Temporal addresses.

`npm run temporal:dev` reads `packages/temporal-worker/.env`. The local file
normally supplies:

```dotenv
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLOUDFLARE_ACTIVITY_GATEWAY_URL=http://127.0.0.1:3742
CLOUDFLARE_ACTIVITY_SIGNING_KEYS=[{"id":"local-activity-v1","secret":"replace-with-at-least-32-characters"}]
```

Use the same `CLOUDFLARE_ACTIVITY_SIGNING_KEYS` value in `packages/worker/.env`.
Keep it separate from the gateway key set used for Cloudflare-to-Temporal
requests.

Prometheus metrics bind to `127.0.0.1:9464` outside production by default.
Override that with `TEMPORAL_METRICS_BIND_ADDRESS`.

## Build and verification

- `npm run temporal:test` — Temporal unit, integration, and replay tests.
- `npm run temporal:typecheck` — typechecks the worker and gateway.
- `npm run temporal:build` — creates the deterministic production workflow
  bundle at `packages/temporal-worker/dist/workflow-bundle.js`.
- `npm run temporal:validate` — typecheck, tests, and workflow bundle.

The production container uses Node 26 on Debian/glibc, loads the prebuilt
workflow bundle, exposes metrics on port 9464, and handles `SIGTERM`/`SIGINT`
with graceful Temporal worker shutdown. The repository does not select or deploy
a production Temporal service or worker runtime.

See
[Temporal foundation](../../docs/contributing/architecture/temporal-foundation.md)
for cross-plane security, payload limits, data ownership, and the complete local
startup sequence.
