# P1 pruned tooling

Cloudflare-only tooling removed in P1. The Node front door, storage, and e2e
harness replace these paths in later POC phases.

| Path                                                               | Reason                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `tools/apply-local-app-migrations.ts`                              | Wrangler local development or D1 persistence             |
| `tools/build-highlight-test-service.ts`                            | Workers pool auxiliary service                           |
| `tools/build-jobs-test-service.ts`                                 | Workers pool auxiliary service                           |
| `tools/check-deploy-guardrails.ts`                                 | Cloudflare deploy, startup, or Worker tooling            |
| `tools/check-origin-production-exports.ts`                         | Cloudflare deploy, startup, or Worker tooling            |
| `tools/check-worker-startup-bundles.ts`                            | Cloudflare deploy, startup, or Worker tooling            |
| `tools/check-worker-startup-time.ts`                               | Cloudflare deploy, startup, or Worker tooling            |
| `tools/ci/backup-resources-cli.ts`                                 | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/backup-resources-reconcile-cli.ts`                       | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/backup-resources.ts`                                     | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/do-deletion-allowlist.json`                              | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/durable-object-baseline.json`                            | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/is-retryable-deploy-failure.ts`                          | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/jobs-worker-resources.ts`                                | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/nx-cache-resources.ts`                                   | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/origin-production-deploy-state.ts`                       | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/platform-worker-config.ts`                               | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/preview-resources.ts`                                    | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/production-queue-resources.ts`                           | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/production-resources.ts`                                 | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/reset-migration-bookkeeping.ts`                          | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/runtime-worker-config.ts`                                | Cloudflare resource provisioning or deploy configuration |
| `tools/ci/sync-worker-secrets.ts`                                  | Cloudflare resource provisioning or deploy configuration |
| `tools/deploy.ts`                                                  | Cloudflare deploy, startup, or Worker tooling            |
| `tools/disaster-recovery/canonical-json.ts`                        | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/canonical-readiness-cli.ts`               | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/canonical-readiness.ts`                   | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/d1-restore-drill-cli.ts`                  | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/d1-restore-drill.ts`                      | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/disaster-recovery-test-support.ts`        | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/readiness-assessment.ts`                  | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/readiness-contracts.ts`                   | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/readiness-evidence-schema.ts`             | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/readiness-validation.ts`                  | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/readme.md`                                | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/restore-trust.ts`                         | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/seal-escrow.ts`                           | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/trusted-backup-manifest-public-keys.json` | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/trusted-d1-restore-identities.json`       | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/trusted-readiness-public-keys.json`       | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/trusted-restore-baselines.json`           | D1/R2 backup and restore control plane                   |
| `tools/disaster-recovery/unseal-escrow.ts`                         | D1/R2 backup and restore control plane                   |
| `tools/e2e-cloudflare-mock-state.ts`                               | Cloudflare deploy, startup, or Worker tooling            |
| `tools/export-d1-remote-to-sqlite.sh`                              | Cloudflare deploy, startup, or Worker tooling            |
| `tools/highlight-test-service.entry.ts`                            | Workers pool auxiliary service                           |
| `tools/jobs-test-service.entry.ts`                                 | Workers pool auxiliary service                           |
| `tools/local-d1-persist.ts`                                        | Wrangler local development or D1 persistence             |
| `tools/local-dev-migrations.ts`                                    | Wrangler local development or D1 persistence             |
| `tools/local-platform-dev-config.ts`                               | Wrangler local development or D1 persistence             |
| `tools/local-runtime-dev-config.ts`                                | Wrangler local development or D1 persistence             |
| `tools/nx-remote-cache-smoke.ts`                                   | Cloudflare Nx cache service                              |
| `tools/origin-vite-startup-build.ts`                               | Cloudflare deploy, startup, or Worker tooling            |
| `tools/origin-worker-config.ts`                                    | Cloudflare deploy, startup, or Worker tooling            |
| `tools/seed-test-data.ts`                                          | Cloudflare deploy, startup, or Worker tooling            |
| `tools/sentry-upload-sourcemaps.ts`                                | Cloudflare deploy, startup, or Worker tooling            |
| `tools/vite-worker-whole-graph-reload.ts`                          | Cloudflare deploy, startup, or Worker tooling            |
| `tools/vitest-global-setup-highlight-test-service.ts`              | Workers pool auxiliary service                           |
| `tools/vitest-global-setup-jobs-test-service.ts`                   | Workers pool auxiliary service                           |
| `tools/worker-additional-module-allowlist.ts`                      | Cloudflare deploy, startup, or Worker tooling            |
| `tools/worker-startup-budget.json`                                 | Cloudflare deploy, startup, or Worker tooling            |
| `tools/worker-startup-bundle-budget.json`                          | Cloudflare deploy, startup, or Worker tooling            |
| `tools/worker-startup-bundle-notes.md`                             | Cloudflare deploy, startup, or Worker tooling            |
| `tools/wrangler-deploy-retry.ts`                                   | Wrangler local development or D1 persistence             |
| `tools/wrangler-env-config.ts`                                     | Wrangler local development or D1 persistence             |
| `tools/wrangler-filter-kody-generated-watch.ts`                    | Wrangler local development or D1 persistence             |
