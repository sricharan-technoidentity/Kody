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

| Section       | Fields / prerequisites                                                                                                                                                       | Proof                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`    | `urlEnvironment`: name of an environment variable containing a sandbox PostgreSQL URL; existing Kody schema, pgvector and permission to SET ROLE `kody_writer`/`kody_reader` | Actual memory/vector rows, owner RLS, reader write rejection, vector query; transaction always rolls back                                   |
| `dynamo`      | `metersTable`, `idempotencyTable`, `runsTable`; existing pk/sk tables                                                                                                        | Two quota contenders with one success; duplicate claim blocked; owner run read and Bob denial; only three UUID-owned keys deleted           |
| `s3`          | `bucket`                                                                                                                                                                     | Runner-input and run-log keys round-trip, then only those objects deleted                                                                   |
| `kms`         | `keyId`                                                                                                                                                                      | Envelope round-trip and other-user context rejection; no persistent object                                                                  |
| `runtime`     | `arn`, `compatibleWorkerdHost: true`, `invocationFile`, `sessionId`, `expectedResult`                                                                                        | Referenced graph executes and exact response matches; invocation file contains bundleKey/runToken/runId for a registered trusted broker run |
| `interpreter` | `identifier`; existing session image supplies `tsc`                                                                                                                          | Upload/read valid TypeScript, check it, reject invalid types, stop session even on failure; no dependency installation                      |
| `identity`    | `workload`, `userId`, `provider`, optional `scopes`                                                                                                                          | Retrieve an already-authorized token without recording it; absent consent is a pending prerequisite                                         |
| `embeddings`  | `{}` or `modelId`; also requires `postgres`                                                                                                                                  | Titan-compatible 1024-dimensional embedding and live vector search with rolled-back rows                                                    |
| `ses`         | `from`: existing verified sender                                                                                                                                             | Synthetic mail to `success@simulator.amazonses.com`, recording message ID                                                                   |

Every configuration requires `region`. The result file
[aws-evidence.json](./aws-evidence.json) contains timestamps, statuses and
sanitized resource/evidence fields. Errors retain only their name and HTTP
status; credentials, tokens, database passwords and provider response bodies are
omitted. Cleanup failure makes a proof fail. SES simulator delivery cannot be
undone. Runtime proofs use an existing referenced graph/registered run; the
command does not delete caller-owned objects or revoke pre-existing connections.

`npm run demo:runner:build` produces `dist/runner`: a bundled Node host, workerd
bundler assets, dependency manifest and ARM64 Dockerfile. Build that context on
an ARM64-capable builder with `docker build --platform linux/arm64 dist/runner`.
The host listens on `0.0.0.0:8080`, accepts referenced invocations at POST
`/invocations`, and returns stable health timestamps with
`Healthy`/`HealthyBusy` at GET `/ping`, following
[the AgentCore HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html).

Supply `AWS_REGION`, `S3_BUCKET_BUNDLES`, and trusted HTTPS `BROKER_URL` /
`EGRESS_URL` to the host. Its role reads graphs from the existing bucket. A
trusted broker verifies the run token and registered owner through its internal
`/authorize` route before the host reads the exact owner/run graph key. The host
receives no signing key. Native workerd speaks only to local TLS relays for that
broker and egress proxy; sandbox code receives no AWS credentials. Broker run
registrations must exist for the invocation lifetime. Deployment, credentials,
network reachability and distributed broker registrations remain operator work.
An incompatible deployed runtime stays pending.

Identity connections require prior authorization following
[AWS's token flow](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-authentication.html).
This command never starts consent. CodeCommit, CodeArtifact, AgentCore-hosted
MCP, cloud networking, telemetry, backups, realtime transport and production
billing remain future work. Passing individual proofs cannot establish
whole-application AWS deployment readiness.
