# ADR-012: Workflow Resume Boundary (Bevox Callback Reverso)

**Status:** Accepted
**Date:** 2026-05-14
**Slot:** bevox-harness
**Related:** Sprint C.1 (Workflow Engine)

## Context

The Workflow Engine introduces suspendable workflows (e.g. wait for
`callback:payment.confirmed`). When the external event finally arrives at
Bevox's orchestration-service, **some component has to call back into the
harness** to resume the persisted workflow.

CLAUDE.md states explicitly: "Harness NÃO expõe API REST — consome de fila
BullMQ e produz callbacks HTTP". The naive option — a public webhook on the
harness — violates that.

Two viable patterns:

1. **Redis pub/sub** (`workflow:resume` channel). Bevox publishes; the
   harness's subscriber resumes. Pro: no inbound port. Con: at-most-once in
   practice (subscriber must be online when message is published; messages
   are not durable on the channel).

2. **Reverse callback over internal HTTP** (G.11). The harness exposes a
   single, narrowly-scoped resume endpoint on a **private interface**
   (`127.0.0.1` bind or Unix socket), authenticated with a shared secret,
   reachable only from Bevox over a trusted internal network (VPC, mesh,
   sidecar). Pro: durable retries by Bevox; idempotent. Con: harness now
   accepts inbound — but only on a trusted boundary, not the public internet.

## Decision

Use **option 2: a private internal resume endpoint**.

Justification: this does **not** violate the CLAUDE.md rule. The rule
prohibits a *public* REST API to external clients. The resume endpoint is
not public:

- Bind defaults to `127.0.0.1` (localhost only). Deployment can override to
  a private VPC IP.
- Auth: `X-Workflow-Resume-Secret` header with a constant-time compare
  against `WORKFLOW_RESUME_SECRET` (≥ 32 chars). Missing/invalid → 401.
- Account scoping: the request body must include `accountId`. The store
  lookup filters by `(suspendToken, accountId)` jointly, defeating token
  enumeration across accounts.
- Idempotent: resuming a non-suspended workflow is a no-op that returns the
  current status with HTTP 200.

The fallback Redis pub/sub subscriber remains available behind a feature
flag for environments that prefer it (`WORKFLOW_RESUME_VIA_REDIS=true`).

## Consequences

**Positive**
- Bevox can use standard retry/backoff semantics (HTTP) for resume
  delivery; no separate durable bus required.
- Single source of truth for which workflows are suspended (the DB row),
  consulted on every webhook.

**Negative**
- Harness now binds a TCP port (default 127.0.0.1:4500). Ops must ensure
  this is firewalled.
- Shared secret must be provisioned + rotated. Documented in env vars
  (`WORKFLOW_RESUME_SECRET`, `WORKFLOW_RESUME_HOST`, `WORKFLOW_RESUME_PORT`).

## Alternatives Considered

- **Public REST API**: rejected — violates CLAUDE.md.
- **Polling Bevox from harness**: rejected — adds latency, doubles fan-out
  load, ugly retry semantics.
- **Pub/sub only**: rejected as default — non-durable, race-prone when the
  subscriber reconnects. Retained as opt-in fallback.

## Implementation

- `src/workflow/resume-server.ts` — HTTP server with single POST endpoint.
- `src/workflow/subscriber.ts` — Redis pub/sub fallback subscriber.
- Env vars wired in `src/config/env.ts`.
- Bootstrap registers the resume server during stage 7 (`start-consumer`)
  so it boots with the worker.
