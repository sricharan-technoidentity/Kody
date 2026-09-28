# 0051: Temporal orchestrates; Cloudflare stores and executes

- **Status:** accepted
- **Date:** 2026-09-22

## Context

Kody's Cloudflare `JobManager` alarms, cron queue, and `DynamicCallableWorkflow`
provide durable scheduling and workflow behavior, but maintaining retry,
cancellation, fan-out, visibility, and deployment semantics in application code
increases operational risk. The migration needs a durable orchestration control
plane without weakening per-user isolation or moving user code into a trusted
process.

The rejected alternatives are keeping the custom orchestration indefinitely,
replacing all Cloudflare stateful primitives with Temporal, and executing user
packages inside Temporal Activities. The first retains the operational burden;
the second confuses orchestration history with application state; the third
removes the Workers for Platforms isolation boundary.

## Decision

Temporal is Kody's durable orchestration control plane. Cloudflare remains the
authority for user data, edge delivery, realtime state, and isolated package
execution; Temporal inputs and metadata contain only bounded, opaque references.

Temporal namespaces are separated by environment rather than user. `JOBS_DB`
remains authoritative for job definitions, `RunLog` remains authoritative for
user-visible execution history, and effective-once behavior comes from
Cloudflare claim/finalize fences rather than Temporal Activity delivery.

## Consequences

Kody operates an always-on Node worker fleet and a signed HTTPS gateway in
addition to its Cloudflare fleet. Every cross-plane mutation requires HMAC
authentication, replay protection, an idempotency key, and explicit ownership
fields. Temporal Visibility is operational data only and is never used to
reconstruct an account export or deletion.

This decision is revisited only if Temporal cannot meet the measured schedule
volume or data-processing boundary without putting secrets, source, prompts,
outputs, or email bodies into workflow history.
