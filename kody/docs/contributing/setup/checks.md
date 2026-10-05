# Checks

`CI=1 npm run validate` is the authoritative gate. It runs formatting, lint,
typecheck, Node tests, primitives, migrations, documentation language/ADR
numbers, Mermaid, file-size/decorative ratchets, Knip, production audit,
lockfile and exact Cloudflare-reference checks. Keep every gate intact and
report failures.

```bash
npm run demo:check
CI=1 npx vitest run --project node-unit <path>
CI=1 npx vitest run --project mcp-e2e
CI=1 npx playwright test --retries=0
npm run build
CI=1 npm run validate
```

Demo checks cover ten migration acceptance files, Deno compatibility, standalone
Temporal workflow/activity execution and launcher/scenario checks. The retained
browser journeys are smoke, signup/verify/connect, and account navigation, plus
combined demo coverage. Other legacy browser/Workers suites are excluded and do
not count as POC evidence.

Live AWS checks are separately selected with `npm run demo:aws:check` and
explicit sandbox configuration. They are never part of the local validation
gate. See [readiness](../../poc/readiness.md) for fresh results and
prerequisites. No git hooks or production workflows are invoked by the POC
protocol.
