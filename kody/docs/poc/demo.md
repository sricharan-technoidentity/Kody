# Present the local POC

Use Node 26+, npm, Git, curl and tar. Install with
`HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund`, then
`HUSKY=0 npm rebuild --no-audit --no-fund`. Run `npm run demo` (or
`npm run dev`) in one terminal. No existing `.env` or real credentials are
needed: the launcher reads checked-in synthetic defaults and injects explicit
service fakes. First launch downloads the official Temporal CLI into
`node_modules/.cache/kody-demo/`. For restricted networks, set
`KODY_TEMPORAL_EXECUTABLE` to an existing CLI. Preparation completes before any
services start. The application and Temporal UI bind to loopback; use the URLs
printed by the launcher if default ports 3742 and 8233 are occupied.

Workerd remains the supported default. Use
`KODY_RUNNER_BACKEND=deno npm run demo` for the explicit replacement comparison;
`KODY_RUNNER_BACKEND=workerd` selects the baseline. Deno preparation uses the
pinned release or `KODY_DENO_EXECUTABLE`. There is no automatic fallback after
dispatch. This selector does not establish completion of the compatibility gates
in [package execution evidence](./package-execution.md).

Sign in with `alice@example.invalid` / `demo-password-123`. Alice owns a private
report package and an approved synthetic preference memory. Bob uses
`bob@example.invalid` / `demo-password-123`. These are disposable fixture
accounts. The report stores synthetic labels in its package-owned SQLite cell.

Run `npm run demo:run` from another terminal in this workspace. Allow about
10–15 minutes for presentation, including browser exploration. The script
discovers the existing `search` and `execute` MCP tools through real OAuth,
verifies and saves an approved memory, then searches for it. Open the printed
memories link to inspect it.

The script opens a real Git-backed report session, edits the application export,
checks and publishes it through the existing capabilities, and verifies the
published app response. Follow its app link. Source REST/token endpoints are
local fixtures. The interpreter's typecheck/lint results are scripted; local
package manifest, documentation and bundling checks still run. This cannot
establish live Code Interpreter or CodeCommit readiness.

Two HTTP webhook requests carry the same idempotency key. Expect one execution,
a replay response, and exactly one matching storage row. A one-time schedule
then fires the report. Inspect the job and workflow in the printed Temporal UI
and the account's activity page. The synthetic webhook URL is a credential: the
presenter control endpoint keeps it private and the script does not print it.

A controlled activity failure occurs before package execution. Temporal retries
that safe failure, and the script verifies one resulting report row. Next a
separate deferred workflow survives a restart of the four worker pools while
Temporal and stores remain running. These run sequentially within the account's
existing concurrency limit. Existing HTTP mutation, execute, job and
outbound-mail handlers retain their single-attempt policies for uncertain
effects.

Sign in as Bob. The script verifies he cannot read Alice's private memory,
package, package storage or run records. No external AI model or MCP host is
required. Email, embeddings and connector Identity are simulated as documented
in [the service matrix](./architecture.md).

Run `npm run demo:reset` to recreate only this session's stores, Git fixture,
Temporal server and workers. A new report package ID confirms reset completion.
Run the scenario again; distinct synthetic markers also allow repeated scenarios
without a reset. A workspace lock prevents competing launchers. Presenter
controls use a random token stored in a mode-0600 temporary state file;
arbitrary SQL test controls exist only in the separate browser-test launcher.
Ctrl+C closes owned processes and removes temporary fixtures/state. State lasts
for one launcher session; persistent cloud storage is outside this
demonstration.

Run `npm run demo:check` for the focused acceptance/native/Temporal checks,
`npm run docs:check-poc` for current links/scripts, and `npm run test:mcp` plus
`npm run test:e2e:run` for the retained transport/browser journeys. The
standalone Temporal test server can use `KODY_TEMPORAL_TEST_EXECUTABLE` when its
SDK download is unavailable. Application changes also require unchanged
`CI=1 npm run validate` and `npm run build`.
[Readiness evidence](./readiness.md) records fresh outcomes.
