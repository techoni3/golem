# REPO-MAP.md
> Last verified: 2026-07-23 @ e5e88b3 — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply` under `GOLEM_HOME`; completions/aliases never edit shell RC files.
- `packages/` contains typed domain, client, testkit, UI, and adapters; agent transports consume canonical ports without storage.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. API/client/MCP are storage-free; `substrate/` renders `plugin/` and `dashboard/dist/`.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client; compat/storage/UI/harness do not import inward.
- One npm11 lock; `packages/persistence` is the sole SQLite writer, recovery owner, and migration owner.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; exceptional close is server-composed.
- `CommandGateway` makes tracker/management mutations and durable GOL-79 receipts one SQLite transaction: replays are inert, changed keys return `409 command.idempotency_mismatch`, and trigger invalidations/settlement/direct-core writes share that commit. Semantic changes publish once; scope filtering precedes WS frames; HTTP revisions are truth.
- `TicketDispatchService` is the sole browser/bearer/MCP delivery seam: only the current assignee resolves fail-closed to an eligible active generation; `tracker_envelopes` queues in the GOL-79 transaction as `ready`/`pull_only`/`next_turn`. Terminal/ineligible writes create none; stale CAS is replayable. Historical fields/runtime references never select a target; only the server-authenticated MCP route carries its scoped legacy alias/content, and durable `mcp` binding—not environment credential spelling—defines provenance.
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
