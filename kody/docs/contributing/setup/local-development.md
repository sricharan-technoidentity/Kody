# Local development

Use Node 26+ and npm 11. Run the install commands in the
[README](../../../README.md), then `npm run dev` (same as `npm run demo`). No
`.env` is loaded. Local services use synthetic fixture values and loopback
bindings. The launcher checks Temporal and Deno, seeds demo accounts, waits for
readiness, and prints URLs.

Temporal's first use downloads its development-server executable. Set
`KODY_TEMPORAL_EXECUTABLE=/absolute/path/to/temporal` for an existing CLI.
Interrupt the launcher to close the front door, Vite, workers, Temporal, source
fixture, Deno, SQLite cells and PGlite stores. State lasts for this session. See
[walkthrough](../../poc/demo.md) for reset and worker restart.

`npm run dev:client` starts Vite alone and is not a complete application
launcher. Browser tests use `npm run e2e:web-server`, with separate private test
controls. Presenter controls never expose SQL or arbitrary fixture seeding. See
[architecture](../../poc/architecture.md) for fakes and limits.
