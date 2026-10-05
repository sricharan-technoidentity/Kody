# Demo readiness evidence

Fresh local verification on 2026-10-04 uses Node 26.10.0, Temporal CLI 1.9.1
(server 1.32.0), native workerd 1.20260815.1 and Chromium 151. Historical P8
counts are retained in the audit archive and are not counted as fresh evidence.

The 2026-10-05 [package execution replacement evidence](./package-execution.md)
supersedes the standalone Runner artifact details below: it uses Node and pinned
Deno, with an integrated Temporal-to-AgentCore proof command. The local ARM64
image smoke check and Deno-default MCP suite passed. The local launcher and
toolchain use Deno/esbuild/TypeScript; workerd and worker-bundler execution
dependencies are retired. Live proofs remain pending. Fresh final checks are
recorded on the replacement evidence page; the historical table below is not the
Deno replacement verification count. The replacement's unchanged full gate
passed all 14 checks; **1,141 Node files / 3,632 tests** passed uncached. The
final combined run reused that Node result after evidence formatting was fixed.
The focused suite passed **25 files / 49 tests**, MCP passed **5 files / 7
tests**, and client/SSR build and demo typecheck passed. The earlier CLI
metadata timeout was fixed at the routing boundary; its retained regression
proves reads do not need Temporal. Steps 4 and 5 are complete for the local
replacement.

Docker verification was repeated on 2026-10-05 after the daemon became
available: the ARM64 runner image built using cached layers, and its existing
network-disabled smoke test passed freshly as the non-root `node` user with Deno
2.9.7. Image inspection confirmed `linux/arm64` and port `8080/tcp`; the smoke
container was removed. See the replacement evidence for the image ID. Live AWS
proofs remain pending; no image was pushed or deployed.

## Historical readiness: 2026-10-04

The tables and observations below describe the original workerd POC. Current
Deno evidence and AWS status are linked above.

| Plan step                                            | Status                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| Documentation consolidation and safe cleanup         | Implemented; current link/script checks pass                    |
| Shared bootstrap and local launcher                  | Implemented; startup/partial failure/native cleanup checks pass |
| Combined memory/MCP and package demo                 | Implemented; full script and Chromium story pass                |
| Optional AWS proofs and Runner host artifact         | Implemented; live proofs pending configuration                  |
| Fresh verification, no-env startup, reset and repeat | Complete for the local POC                                      |

| Fresh command/check                                                   | Result                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run demo:check` with existing Temporal CLI/test-server paths     | 19 files / 25 tests passed on the final implementation                    |
| Targeted final bootstrap, HTTP Runner and native compatibility checks | 3 files / 6 tests passed, including direct native listener shutdown       |
| `CI=1 npm run test:mcp` with Nx cache disabled                        | 5 files / 7 tests passed                                                  |
| `npm run test:e2e:demo`                                               | 1 combined Chromium story passed                                          |
| `CI=1 npx playwright test --retries=0`                                | 7 tests across the three retained journeys passed                         |
| `npm run build`                                                       | Client and SSR build passed                                               |
| `npm run demo:typecheck`                                              | Passed                                                                    |
| `npm run docs:check-poc`                                              | 28 current pages passed                                                   |
| `npm run cloudflare:check`                                            | 256 exactly documented files passed                                       |
| `npm run demo:runner:build` plus local artifact invocation            | Build passed; bundled HTTP host executed a referenced native graph        |
| Default `prepareTemporal()` download                                  | Official CLI download, version check and cache preparation passed         |
| Unchanged `CI=1 npm run validate`                                     | All 14 gates passed; 1,133 Node files / 3,601 tests; no failures or skips |

The combined scenario verifies the two MCP tools, an approved searchable memory,
a real local Git edit/check/publish, the published app output, duplicate public
HTTP webhook delivery producing one row, a one-time package schedule, controlled
pre-execution retry producing one row, deferred completion after worker restart,
and Bob's memory/package/storage/run isolation. A wrong-secret webhook request
with Bob's cookie also returns 404 and leaves no report row.

[Final local evidence](./local-evidence.json) records fresh startup with the
existing `.env` temporarily absent, default cached CLI selection, owned reset,
and two consecutive successful walkthroughs after reset. The original `.env` was
restored before the scenarios. Reset produced a new package ID and cleared retry
state. Shutdown immediately after another reset request removed owned state, and
process inspection found zero native workerd processes tied to removed fixtures.
The final full Node suite ran without Nx cache in 1,182.29 seconds; unchanged
lint accepts its existing warnings. Subsequent format, Knip, documentation and
demo type checks also pass. No check was weakened.

The first browser attempts found a missing Chromium binary, an incorrect new
test button locator and cold-route compilation exceeding a five-second
assertion. Chromium is installed; locators and bounded hydration/navigation
waits are fixed. The final retained browser result uses zero retries. Required
checks were retained.

All nine services in [AWS evidence](./aws-evidence.json) are `pending`: no
separate sandbox configuration was supplied. The adapters use live SDKs and
report missing resources/consent without fake fallback. The ARM64 Docker build
context is produced, but an ARM64 container build and deployed AgentCore Runtime
invocation are unverified; the local Docker daemon is unavailable. No resource
provisioning, deployment, live data migration, cutover, or changes to this
checkout's Git index/history were performed.

Local source REST/check results, AWS services, Identity, embeddings and mail use
explicit fakes. PGlite, PostgreSQL schema/RLS/pgvector, SQLite storage cells,
Temporal, OAuth/MCP and native workerd are real local components. See
[architecture](./architecture.md), [presenter flow](./demo.md),
[AWS prerequisites](./aws.md) and
[remaining ceilings](../migration/p8-shortcuts.md).
