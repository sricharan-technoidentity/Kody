# kody agent index

## Current mode: POC (Temporal + AgentCore migration)

For the current migration POC, use this reduced scope. Do not run production
workflows.

- Read [`planss/kody-migration-plan.md`](./planss/kody-migration-plan.md) first;
  `planss/execution plan.md` is a duplicate and should not be edited.
- Goal: prove one vertical slice of Temporal + AgentCore in isolation.
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

For migration work, read the documents in `planss/` in this order:

1. [Current component reference](./planss/Kody%20Architecture%20%E2%80%94%20Component%20Reference.md)
   and the live [architecture docs](./docs/contributing/architecture/index.md)
   for the Cloudflare system. Where a snapshot conflicts with the repository or
   an accepted decision, use the repository and the
   [decision index](./docs/contributing/decisions/index.md).
2. [Component comparison](./planss/Kody%20on%20Temporal%20%2B%20AgentCore%20%E2%80%94%20Component%20Comparison.md)
   and [target architecture](./planss/Kody%20on%20Temporal%20%2B%20AgentCore%20%E2%80%94%20Target%20Architecture.md)
   for the proposed AWS and Temporal system, its unverified assumptions, and
   the production data-copy and cutover plan. Treat target behavior as a
   proposal until implemented.
3. [POC execution plan](./planss/kody-migration-plan.md) for phased
   implementation and phase status. `planss/execution plan.md` is a duplicate;
   update only `kody-migration-plan.md` when recording POC progress. The POC
   excludes live data migration, deployment, and cutover.

Preserve per-user isolation, the two-tool MCP surface, existing package
behavior, and published URLs and grants. The `workerd` Runner is the critical
compatibility proof: fakes alone do not establish that published packages run
unchanged. POC phase checks are incremental; the plan's instruction not to run
`npm run validate` during POC work does not replace the repository's
authoritative gate. Do not claim production migration complete from POC gates.

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
