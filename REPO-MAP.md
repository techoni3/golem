# REPO-MAP.md
> Last verified: 2026-07-23 @ 1a60936 — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply` under `GOLEM_HOME`; completions/aliases never edit shell RC files.
- `packages/` contains typed domain/client/testkit/UI/adapters. Managed Codex transport is storage-free; OpenCode, Claude, and Pi consume canonical ports.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. Typed API, generated client, and MCP are storage-free. `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays and owns managed migrations.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; managed migrations own phase-evidence relations such as comment dispatches; exceptional close is server-composed.
- One typed `CommandGateway` routes tracker/management mutations through one SQLite transaction and persists a durable receipt/outcome per `(project_id, idempotency_key)` (`tracker/007`); replay has no side effect and changed reuse is `409 command.idempotency_mismatch`. `tracker/008`/`009` trigger-owned opaque invalidations share that commit, delivery settlement, and direct-core writes; semantic comparisons guarantee exact-once, scope filtering precedes WS frames, and HTTP revisions remain truth.
- `TicketDispatchService` is the sole browser/bearer/MCP ticket-delivery policy seam: the current assignee resolves fail-closed to an active generation, typed persistence eligibility retains canonical fence/lease/health/control/consumer/capability checks while classifying `ready`/`pull_only`/`next_turn`, and one durable `tracker_envelopes` row is queued inside the GOL-79 transaction. Terminal/ineligible writes create none; a stale ticket CAS is a durable replayable result. Historical dispatch fields and runtime references never select a target; only the separately authenticated MCP route can carry its scoped legacy alias/content.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS. Browser work is cookie-only for reads/WS and CSRF+gateway-only for commands; GOL-80 scopes opaque frames before construction. Resolver-owned bindings reject request authority fields; foreign detail is absent.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Projections read canonical rows only; diagnostics and WS invalidations are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, named journeys, render, and `git diff --check`.
