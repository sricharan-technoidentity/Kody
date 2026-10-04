# kody agent index

## Current mode: POC (Temporal + AgentCore migration)

For the current migration POC, use this reduced scope. Do not run production
workflows.

- Read [`planss/kody-migration-plan.md`](./planss/kody-migration-plan.md) first;
  then the demo readiness plan; historical execution logs are archived.
- Goal: execute the demo readiness plan step by step in isolation.
- Out of scope: live data migration, deployment, cutover, preview testing,
  production health checks, PR shipping, Discord summaries, visual recaps.
- Do not invoke `ship-pr`, `preview-manual-test`, `control-kody` preview/health,
  `visual-recap`, `conduct`, or `file-friction` for POC work.
- Do not run full `npm run validate` unless the slice modifies existing Kody
  code; prefer targeted tests for the slice.
- Verification: unit/integration tests for the slice + a standalone Temporal
  workflow/activity test.
- Stop when the slice demonstrates the behavior. Do not fix unrelated friction.

When not in POC mode, the rest of this file applies.

---

Kody is a multi-user personal assistant: every signed-in user gets a fully
isolated assistant (own packages, jobs, secrets, memories, remote connectors,
email inboxes, durable storage).

`npm run validate` is the single authoritative local gate.

## Temporal + AgentCore migration context

Read [current migration overview](./planss/kody-migration-plan.md), then the
[demo readiness plan](./planss/poc-demo-readiness-plan.md),
[POC architecture](./docs/poc/architecture.md) and
[fresh readiness evidence](./docs/poc/readiness.md).

Preserve owner isolation, the two MCP tools, package compatibility and published
URLs/grants. Use `npm run demo` / `npm run dev` for the local launcher and
`npm run demo:check` for focused evidence. Existing Kody code changes require
the unchanged `CI=1 npm run validate`. Browser tests use separate test controls.
Only explicitly configured sandbox service proofs may contact existing AWS
resources; never deploy, provision, cut over or copy live data. No git writes.
Historical P0–P8 evidence and proposals live in
`docs/audits/migration-2026-10-04`.

This file is intentionally brief. Detailed instructions live in focused docs:

- Contributor documentation map:
  - [docs/contributing/index.md](./docs/contributing/index.md)
- Friction log (when/where to file, how to judge fixes; one issue via
  `kody:@kentcdodds/friction-log/create`, ship-pr leftovers via
  `kody:@kentcdodds/friction-log/file`, never raw GitHub):
  [docs/contributing/friction-log.md](./docs/contributing/friction-log.md)
- Project intent and scope:
  [docs/contributing/project-intent.md](./docs/contributing/project-intent.md)
- Decision records (steering veto list — open before proposing a new primitive
  or surface):
  [docs/contributing/decisions/index.md](./docs/contributing/decisions/index.md)
- Setup, checks, docs maintenance, preview deploys, and seeding:
  - [docs/contributing/setup/index.md](./docs/contributing/setup/index.md)
- Manual PR preview testing (medium/high risk, logged-in user + data):
- [docs/contributing/preview-manual-testing.md](./docs/contributing/preview-manual-testing.md)
  and the
  [preview-manual-test skill](./.agents/skills/preview-manual-test/SKILL.md)
- App verification CLI and Feature Map:
- [docs/contributing/control-kody.md](./docs/contributing/control-kody.md) and
  the [control-kody skill](./.agents/skills/control-kody/SKILL.md)
- Documentation principles (usage vs contributing, MCP text, gardening, prefer
  checkers over should-lists):
  - [docs/contributing/documentation.md](./docs/contributing/documentation.md)
- Code style conventions:
  - [docs/contributing/code-style.md](./docs/contributing/code-style.md)
- Enforced app / MCP / worker / universal import layering:
  [docs/contributing/import-boundaries.md](./docs/contributing/import-boundaries.md)
- Testing guidance:
  - [docs/contributing/testing-principles.md](./docs/contributing/testing-principles.md)
  - [docs/contributing/end-to-end-testing.md](./docs/contributing/end-to-end-testing.md)
- Tooling and framework references:
  - [docs/contributing/harness-engineering.md](./docs/contributing/harness-engineering.md)
  - [docs/contributing/oxlint-js-plugins.md](./docs/contributing/oxlint-js-plugins.md)
  - [docs/contributing/remix.md](./docs/contributing/remix.md) and the
    repo-local [Remix skill](./.agents/skills/remix/SKILL.md)
  - [docs/contributing/no-flash-navigation.md](./docs/contributing/no-flash-navigation.md)
    (client routes keep the previous page until the next one is ready)
  - [docs/contributing/cloudflare-agents-sdk.md](./docs/contributing/cloudflare-agents-sdk.md)
- MCP capabilities (search/execute graph, domains, registry):
  - [docs/contributing/adding-capabilities.md](./docs/contributing/adding-capabilities.md)
- Project setup references:
  - [docs/contributing/getting-started.md](./docs/contributing/getting-started.md)
  - [docs/contributing/environment-variables.md](./docs/contributing/environment-variables.md)
  - [docs/contributing/setup-manifest.md](./docs/contributing/setup-manifest.md)
- Architecture references:
  - [docs/contributing/architecture/index.md](./docs/contributing/architecture/index.md)
    (production worker fleet, request lifecycle, authentication, data storage,
    and the rest of the architecture leaves)
  - Inbound webhooks (rotate keeps the previous URL live briefly):
    [docs/use/webhooks.md](./docs/use/webhooks.md) and
    [docs/contributing/architecture/webhooks.md](./docs/contributing/architecture/webhooks.md)
  - [docs/contributing/architecture/primitives.yaml](./docs/contributing/architecture/primitives.yaml)
    (stable taxonomy, not a feature changelog — see the architecture index for
    the classify/check workflow)
- PR system recaps (visual plan/recap blocks in PR descriptions):
  - [.agents/skills/visual-recap/SKILL.md](./.agents/skills/visual-recap/SKILL.md)

## Cursor Cloud-specific instructions

Cloud Agent VM gotchas (Node 26 on `PATH`, the Playwright browser-install hang
and manual workaround, dev server, seeding, and local limitations) live in a
dedicated reference:

- [Cursor Cloud Agent notes](./docs/contributing/cloud-agents.md)
