# Kody Temporal gateway

This package is the signed HTTP control-plane adapter between Cloudflare and
Temporal. It can start, signal, cancel, describe, and sample workflows, and
upsert, describe, or delete Schedules. It never accepts arbitrary SQL, binding
names, or callback URLs.

Every route except `GET /health` requires the shared Temporal signature headers:
key id, timestamp, nonce, body digest, signature, and operation-specific
idempotency key. The gateway enforces a five-minute clock window, a 64-KiB body
limit, nonce replay protection for the life of the process, strict request
schemas, and a per-key request limit.

## Local development

Start a Temporal development server before the gateway, then run:

```sh
npm run temporal:gateway
```

The script reads `packages/temporal-gateway/.env`. A local file normally
contains:

```dotenv
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_GATEWAY_SIGNING_KEYS=[{"id":"local-gateway-v1","secret":"replace-with-at-least-32-characters"}]
PORT=8080
```

Use the same `TEMPORAL_GATEWAY_SIGNING_KEYS` value in the Cloudflare worker and
jobs-worker environments. Do not reuse the Activity Gateway signing keys.

The server listens on `0.0.0.0:${PORT}` and defaults to port 8080.
`TEMPORAL_GATEWAY_REQUESTS_PER_MINUTE` defaults to 300 per signing key. Network
ingress controls and coarse rate limiting are deployment responsibilities.

The process emits one bounded `temporal_gateway_request` event per request with
the normalized route, status, authentication outcome, and duration. It does not
log bodies or workflow identifiers.

The package has no selected production deployment in this change. Its in-memory
nonce store is suitable for the local proof path; a production topology must
preserve the signed contract while choosing ingress, scaling, and replay-state
controls deliberately.

See
[Temporal foundation](../../docs/contributing/architecture/temporal-foundation.md)
for the paired worker, Cloudflare Activity Gateway, and data-processing
boundary.
