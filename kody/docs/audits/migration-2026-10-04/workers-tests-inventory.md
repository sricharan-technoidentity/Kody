> Historical evidence preserved on 2026-10-04. Commands and topology below
> describe the recorded phase, not current demo instructions.

# Workers test migration inventory

Rule numbers follow section 5 of
[`kody-migration-plan.md`](../../planss/kody-migration-plan.md). P1 deletes only
rule-1 Cloudflare mechanics; other tests keep their behavioral assertions for
the owning phase.

| Test                                                                                        | Rule | Owner | P1 action                                            |
| ------------------------------------------------------------------------------------------- | ---- | ----- | ---------------------------------------------------- |
| `packages/shared/src/password-hash.workers.test.ts`                                         | 3    | P6    | Verify runtime contract in P6                        |
| `packages/worker/src/app/account-usage-story.workers.test.ts`                               | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/app/anonymous-html-edge-cache.workers.test.ts`                         | 1    | P1    | Delete: Cloudflare Cache API and waitUntil mechanics |
| `packages/worker/src/app/package-app-origin.workers.test.ts`                                | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/billing/credit-wallet.workers.test.ts`                                 | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/billing/stripe-plan-refresh-do.workers.test.ts`                        | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/billing/stripe-webhooks.workers.test.ts`                               | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/billing/subscription-sync.workers.test.ts`                             | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/cli-client-metadata.workers.test.ts`                                   | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/community/community-flow.workers.test.ts`                              | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/community/community-icon.workers.test.ts`                              | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/community/og-image.workers.test.ts`                                    | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/community/package-url.workers.test.ts`                                 | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/community/profile-service.workers.test.ts`                             | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/deferred-work.workers.test.ts`                                         | 1    | P1    | Delete: ExecutionContext.waitUntil mechanics         |
| `packages/worker/src/dr/do-pitr.workers.test.ts`                                            | 1    | P1    | Delete: Durable Object PITR RPC mechanics            |
| `packages/worker/src/dr/mailbox-importer.workers.test.ts`                                   | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/delivery-events.workers.test.ts`                                 | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-account-isolation.workers.test.ts`                       | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-authority-recovery.workers.test.ts`                      | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-classification.workers.test.ts`                          | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-due-owners.workers.test.ts`                              | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-entitlements.workers.test.ts`                            | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-spam-controls.workers.test.ts`                           | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound-storage-meter.workers.test.ts`                           | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/inbound.workers.test.ts`                                         | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-do.workers.test.ts`                                      | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-inbound-authority-guard.workers.test.ts`                 | 4    | P3    | Call replacement service in owning phase             |
| `packages/worker/src/email/mailbox-inbound-effect-ledger.workers.test.ts`                   | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-inbound-graph-commit.workers.test.ts`                    | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-inbound-ledger.workers.test.ts`                          | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-mutations.workers.test.ts`                               | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-provider-index-repair.workers.test.ts`                   | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/mailbox-retention.workers.test.ts`                               | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/outbound-abuse.workers.test.ts`                                  | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/outbound-mailbox-mirror.workers.test.ts`                         | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/outbound-provider-index.workers.test.ts`                         | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/outbound-storage-meter.workers.test.ts`                          | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/outbound.workers.test.ts`                                        | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/reconcile-inbound-system-authority.workers.test.ts`              | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/repo-attachments.workers.test.ts`                                | 4    | P4    | Call replacement service in owning phase             |
| `packages/worker/src/email/repo-body-limits.workers.test.ts`                                | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/repo-search.workers.test.ts`                                     | 4    | P3    | Call replacement service in owning phase             |
| `packages/worker/src/email/sender-rules.workers.test.ts`                                    | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-email-admin-list.workers.test.ts`                         | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-email-authority.workers.test.ts`                          | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-email-retention-graph.workers.test.ts`                    | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-email-subscriptions.workers.test.ts`                      | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-email.workers.test.ts`                                    | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/system-outbound.workers.test.ts`                                 | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/email/user-email-mailbox-flow.workers.test.ts`                         | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/entitlements/d1-storage-reconciliation.workers.test.ts`                | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/entitlements/entitlements-service.workers.test.ts`                     | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/entitlements/user-meter.workers.test.ts`                               | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/identity/background-mcp-user.workers.test.ts`                          | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/index.workers.test.ts`                                                 | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/jobs/repo.workers.test.ts`                                             | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/capabilities/admin/package-scope-grants.workers.test.ts`           | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/capabilities/runs/runs.workers.test.ts`                            | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/capabilities/storage/storage-capability-isolation.workers.test.ts` | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/execute-console-capture.workers.test.ts`                           | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/execute-dynamic-worker-reuse.workers.test.ts`                      | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/fetch-gateway.workers.test.ts`                                     | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/kody-evaluate-binding.workers.test.ts`                             | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/observability.workers.test.ts`                                     | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp/unbound-runtime-helpers-bundle.workers.test.ts`                    | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp-auth.workers.test.ts`                                              | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp-client/client-id-metadata.workers.test.ts`                         | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/mcp-client/hub.workers.test.ts`                                        | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/oauth-handlers.workers.test.ts`                                        | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/oauth-helpers.workers.test.ts`                                         | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/oauth-refresh-family.workers.test.ts`                                  | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/origin-handler.anonymous-html-cache.workers.test.ts`                   | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-invocations/background-identity.workers.test.ts`               | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-invocations/invoke-contract-cache.workers.test.ts`             | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-registry/package-owner.workers.test.ts`                        | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-registry/repo-search.workers.test.ts`                          | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-retrievers/closed-world-runtime.workers.test.ts`               | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/module-graph.workers.test.ts`                          | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/package-app-remix.workers.test.ts`                     | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/package-secret-authority.workers.test.ts`              | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/package-storage.workers.test.ts`                       | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/realtime-session.workers.test.ts`                      | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/package-runtime/static-call-metering.workers.test.ts`                  | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/platform-feedback/platform-feedback-subscriptions.workers.test.ts`     | 3    | P6    | Moved from P3: runs package code and RunLog ledger   |
| `packages/worker/src/repo/published-bundle-artifacts-repo.workers.test.ts`                  | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/repo/repo-session-blobs.workers.test.ts`                               | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/repo/repo-session-index.workers.test.ts`                               | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/run-records/continuity-and-retention.workers.test.ts`                  | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/run-records/dedicated-state.workers.test.ts`                           | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/run-records/invocation-ledger.workers.test.ts`                         | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/run-records/run-records.workers.test.ts`                               | 3    | P5    | Rewrite binding setup in owning phase                |
| `packages/worker/src/security/public-route-hardening.workers.test.ts`                       | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/security/security-hardening.workers.test.ts`                           | 3    | P7    | Rewrite binding setup in owning phase                |
| `packages/worker/src/storage-buckets/estimate-backfill.workers.test.ts`                     | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/storage-buckets/service.workers.test.ts`                               | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/storage-runner.workers.test.ts`                                        | 3    | P6    | Rewrite binding setup in owning phase                |
| `packages/worker/src/usage/durable-object-duration-attribution.workers.test.ts`             | 1    | P1    | Delete: Cloudflare Durable Object duration telemetry |
| `packages/worker/src/usage/durable-object-rows-read.workers.test.ts`                        | 3    | P4    | Rewrite binding setup in owning phase                |
| `packages/worker/src/usage/record-usage.workers.test.ts`                                    | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/user-id.workers.test.ts`                                               | 3    | P3    | Rewrite binding setup in owning phase                |
| `packages/worker/src/webhooks/http.workers.test.ts`                                         | 3    | P5    | Rewrite binding setup in owning phase                |
