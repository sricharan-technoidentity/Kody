# Kody — Temporal + AgentCore POC

Kody is a personal assistant home for memories, packages, secrets and
automation, accessible through OAuth-protected MCP `search` and `execute` and a
Remix UI. Every signed-in user has isolated rows, package storage and run
records.

P0–P8 are recorded complete for an isolated migration POC. This checkout
prepares a repeatable local demo; it does not deploy or migrate production data.
See [fresh readiness evidence](docs/poc/readiness.md).

## Local setup

Use Node 26+ and npm 11 from the repository root:

```bash
HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund
HUSKY=0 npm rebuild --no-audit --no-fund
npm run demo
```

No `.env` or real credentials are required. The launcher prints the loopback app
and Temporal UI URLs and demo credentials. Temporal needs a one-time executable
download; restricted environments can set `KODY_TEMPORAL_EXECUTABLE` to an
existing Temporal CLI. Keep the launcher running in one terminal:

```bash
npm run demo:run
npm run demo:reset
npm run demo:run
npm run demo:check
```

`npm run dev` uses the same launcher. Read the
[presenter walkthrough](docs/poc/demo.md) and
[POC architecture/service matrix](docs/poc/architecture.md) for simulated
components and limits. `npm run demo:aws:check` runs separately against
explicitly configured existing sandbox resources; unconfigured services remain
pending.

## Repository and verification

| Directory                          | Responsibility                                                  |
| ---------------------------------- | --------------------------------------------------------------- |
| `packages/worker`                  | Node front door, MCP, Remix, Temporal, AWS ports, native Runner |
| `packages/shared`                  | Portable domain and runtime contracts                           |
| `tools/demo`                       | Launcher, scenarios and optional live service proofs            |
| `docs/poc`                         | Presenter instructions, architecture, fresh evidence            |
| `planss`                           | Current migration overview and readiness implementation plan    |
| `docs/audits/migration-2026-10-04` | Preserved phase evidence and historical proposals               |

`CI=1 npm run validate` remains the authoritative gate. Focused demo checks, MCP
end-to-end tests, browser journeys and client/SSR build provide additional
readiness evidence. See [checks](docs/contributing/setup/checks.md),
[AGENTS.md](AGENTS.md), [contributor documentation](docs/contributing/index.md),
[using Kody](docs/use/index.md) and
[migration overview](planss/kody-migration-plan.md).

## License and contribution

Kody retains the
[Functional Source License, Version 1.1, ALv2 Future License](LICENSE). Each
version becomes Apache License 2.0 on its second anniversary. Repository
contributions require the
[inbound CLA](docs/contributing/inbound-contributions.md); published packages
have no repository CLA or license gate. See [CONTRIBUTING.md](CONTRIBUTING.md).
Original Epic Web attribution remains in source and licensing files.
