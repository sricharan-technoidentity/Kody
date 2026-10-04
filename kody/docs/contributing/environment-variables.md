# Environment variables in the POC

The local launcher reads checked-in `packages/worker/.env.example` and
`.env.test` with dotenv's parser and injects explicit service fakes. Vite's
environment-file loading is disabled. Existing operator `.env` files are ignored
by this launcher; real credentials are unnecessary. Browser tests share this
bootstrap but expose separate authenticated test controls. Vitest retains its
existing test defaults.

`KODY_TEMPORAL_EXECUTABLE` selects an existing official CLI before any service
starts; otherwise first launch prepares a cached binary. `PORT` selects the
preferred loopback app port. The launcher prints the actual available app and
Temporal UI ports. `KODY_TEMPORAL_TEST_EXECUTABLE` selects the standalone
Temporal test-server binary for time-skipping checks. See
[presenter instructions](../poc/demo.md).

For application configuration, add types and validation to
`packages/worker/src/env-schema.ts`; `packages/worker/env.d.ts` extends the
worker-owned schema. The schema uses `remix/data-schema`. Keep
`packages/worker/src/app/env.ts`, checked-in synthetic defaults and the
[setup manifest](./setup-manifest.md) aligned. Node front-door settings and
service ports also have definitions under `packages/worker/src/front-door/`.

Optional live proofs run in a separate shell with AWS's credential provider
chain and `KODY_DEMO_AWS_CONFIG` pointing at a separate JSON file. Do not copy
synthetic example credentials into that shell. Database passwords stay in the
selected URL environment variable; the proof logs only sanitized evidence. See
[AWS prerequisites](../poc/aws.md).

Cloud deployment configuration, production credential wiring and telemetry
pipeline setup remain deferred. The
[original environment reference](../audits/migration-2026-10-04/legacy-environment-variables.md)
preserves historical provider and deployment details without making them POC
setup instructions.
