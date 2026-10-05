# Cloud Agent notes for the local POC

Use the Node/Temporal/Deno launcher described in
[local development](./setup/local-development.md). Cloud Agent VMs may place
Node 22 at `/exec-daemon/node` ahead of nvm; prepend the Node 26 bin directory
to `PATH` and verify `node --version` before running scripts.

Install from the repository root with
`HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund`, then
`HUSKY=0 npm rebuild --no-audit --no-fund`. `npm run demo` / `npm run dev`
starts the complete session with synthetic defaults. No operator `.env`, real
credentials or old sibling-worker bindings are needed. Readiness is checked
before URLs are printed. Keep the launcher attached and interrupt it to clean
up. Use `npm run demo:reset` for owned state; do not delete another session's
stores.

Some Cloud Agent snapshots have shown a Playwright zip-extraction hang. Use
`npm run test:e2e:ensure`: its Cloud Agent Linux path uses native `unzip`
through [the installer](../../tools/install-playwright-browsers-unzip.ts). The
[historical VM reference](../audits/migration-2026-10-04/legacy-cloud-agents.md)
preserves the manual download/extraction workaround. Other hosts may use the
normal Playwright installer. Always match the installed package's browser
revision; a missing Chromium executable prevents browser verification.

Restricted environments can supply `KODY_TEMPORAL_EXECUTABLE` and
`KODY_TEMPORAL_TEST_EXECUTABLE`. The former is validated before services start;
the latter is the standalone time-skipping server for workflow/activity checks.
Loopback listeners are required for local integration tests. A blocked download
or listener is a verification limitation, not a passing result.

Run `npm run demo:check`, the retained `npm run test:mcp` /
`npm run test:e2e:run`, and `npm run test:e2e:demo`. Existing app changes also
require unchanged `CI=1 npm run validate` and `npm run build`. The browser test
launcher has separate authenticated fixture controls. Presenter controls expose
only demo state, reset and worker restart. See
[fresh evidence](../poc/readiness.md).

Production health checks, preview tests, PR shipping, deployment, data migration
and cutover remain outside the POC. Optional live AWS proofs require explicitly
configured existing sandbox resources in a separate shell; see
[AWS prerequisites](../poc/aws.md).
