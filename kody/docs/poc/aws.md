# Individual AWS sandbox proofs

Live proofs are separate from the local demonstration. No service is
provisioned, deployed or migrated. Run `npm run demo:aws:check` in a separate
shell using AWS's credential provider chain. Set `KODY_DEMO_AWS_CONFIG` to an
independent JSON file; do not reuse `.env.example`, `.env.test` or the
launcher's process environment. Example AWS credentials are rejected. Without
configuration all nine proofs stay `pending`; configured failures stay `failed`
and cause a nonzero exit.

Start with [the configuration example](../../tools/demo/aws.example.json) and
add only sections you intend to exercise:

| Section       | Fields / prerequisites                                                                                                                                                       | Proof                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`    | `urlEnvironment`: name of an environment variable containing a sandbox PostgreSQL URL; existing Kody schema, pgvector and permission to SET ROLE `kody_writer`/`kody_reader` | Actual memory/vector rows, owner RLS, reader write rejection, vector query; transaction always rolls back                             |
| `dynamo`      | `metersTable`, `idempotencyTable`, `runsTable`; existing pk/sk tables                                                                                                        | Two quota contenders with one success; duplicate claim blocked; owner run read and Bob denial; only three UUID-owned keys deleted     |
| `s3`          | `bucket`                                                                                                                                                                     | Runner-input and run-log keys round-trip, then only those objects deleted                                                             |
| `kms`         | `keyId`                                                                                                                                                                      | Envelope round-trip and other-user context rejection; no persistent object                                                            |
| `runtime`     | `arn`, `protocol: "kody-deno-v1"`, `broker: { port, publicUrl }`; also requires `s3.bucket`                                                                                  | Real local Temporal activity invokes the existing Deno Runtime; signed broker records one receipt, result matches and is stored in S3 |
| `interpreter` | `identifier`; existing session image supplies `tsc`                                                                                                                          | Upload/read valid TypeScript, check it, reject invalid types, stop session even on failure; no dependency installation                |
| `identity`    | `workload`, `userId`, `provider`, optional `scopes`                                                                                                                          | Retrieve an already-authorized token without recording it; absent consent is a pending prerequisite                                   |
| `embeddings`  | `{}` or `modelId`; also requires `postgres`                                                                                                                                  | Titan-compatible 1024-dimensional embedding and live vector search with rolled-back rows                                              |
| `ses`         | `from`: existing verified sender                                                                                                                                             | Synthetic mail to `success@simulator.amazonses.com`, recording message ID                                                             |

Every configuration requires `region`. The result file
[aws-evidence.json](./aws-evidence.json) contains timestamps, statuses and
sanitized resource/evidence fields. Errors retain only their name and HTTP
status; credentials, tokens, database passwords and provider response bodies are
omitted. Cleanup failure makes a proof fail. SES simulator delivery cannot be
undone. The Runtime proof creates a UUID-owned graph and result object,
temporary broker registration and local Temporal server, then cleans up only
those resources. Other objects and existing connections are untouched.

`npm run demo:runner:build` produces `dist/runner`: a bundled Node host, Deno
bootstrap/Worker, dependency manifest and ARM64 Dockerfile. The image downloads
checksum-verified Deno 2.9.7 at build time; execution uses only that binary. No
workerd or worker-bundler code/assets are included. Build that context on an
ARM64-capable builder, then run the local image smoke check:

```sh
docker build --platform linux/arm64 -t kody-runner-local dist/runner
docker run --rm --platform linux/arm64 --network none \
  --mount "type=bind,src=$PWD/tools/demo/runner-image-smoke.mjs,dst=/tmp/smoke.mjs,readonly" \
  --entrypoint node kody-runner-local /tmp/smoke.mjs
```

The smoke check uses a synthetic loopback broker and in-memory graph inside the
container. It verifies ARM64 Deno execution, default port 8080, health,
filesystem/environment/direct-network denial and shutdown, not AWS transport or
IAM. Nothing is pushed or deployed. The host listens on `0.0.0.0:8080`, accepts
referenced invocations at POST `/invocations`, and returns stable health
timestamps with `Healthy`/`HealthyBusy` at GET `/ping`, following
[the AgentCore HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html).

Supply `AWS_REGION`, `S3_BUCKET_BUNDLES`, and trusted HTTPS `BROKER_URL` /
`EGRESS_URL` to the host. Its role reads graphs from the existing bucket. A
trusted broker verifies the run token and registered owner through its internal
`/authorize` route before the host reads the exact owner/run graph key. The host
receives no signing key. Each invocation starts a restricted Deno subprocess and
Worker with an empty inherited environment and no direct network permissions;
the trusted Node bridge attaches authorization to broker/egress calls. Sandbox
code receives no AWS credentials. Broker run registrations must exist for the
invocation lifetime. Deployment, credentials, network reachability and
distributed broker registrations remain operator work. An incompatible
configured protocol stays pending. Session IDs are derived from the exact
owner/run pair and enforced in the SDK adapter and, when supplied, the host's
AgentCore session header. SDK retries are disabled for dispatch; a lost response
cannot cause automatic execution again.

The existing Runtime must point `BROKER_URL` at `runtime.broker.publicUrl`. That
HTTPS ingress must already forward to the proof machine's selected `port`; the
proof binds its temporary listener to `0.0.0.0` and does not create ingress, TLS
certificates, tunnels or cloud resources. Missing runtime/bucket/ingress
configuration stays pending. The proof's graph checks the pinned Deno version
and returns an unpredictable receipt obtained through the signed broker, so a
configured protocol label alone cannot establish success. No runtime or
connectivity fallback is provided. Local tests inject explicit fake S3/AgentCore
ports around real Temporal, signed broker and Deno; these are not live evidence.

For the host execution role, allow only `s3:GetObject` for
`arn:aws:s3:::BUCKET/*/runner-inputs/*.json`, with the bucket replaced by the
existing sandbox bucket. No list/write/delete permission is needed by the host.
The proof caller separately needs put/delete on its proof-owned keys and invoke
permission for the exact existing Runtime ARN. Any required SSE-KMS permission
must be scoped to the existing bucket/key. Actual role policies, credential
metadata isolation inside AgentCore require a live proof. The local ARM64 image
smoke check establishes container execution and Deno permission denial, not
AgentCore credential isolation or IAM correctness.

Identity connections require prior authorization following
[AWS's token flow](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-authentication.html).
This command never starts consent. CodeCommit, CodeArtifact, AgentCore-hosted
MCP, cloud networking, telemetry, backups, realtime transport and production
billing remain future work. Passing individual proofs cannot establish
whole-application AWS deployment readiness.
