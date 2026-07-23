# REPO-MAP.md
> Last verified: 2026-07-23 @ 037c0bd — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply`; completions/aliases never edit shell RC files.
- `packages/` contains domain, client, testkit, UI, and adapters; transports consume canonical ports without storage.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. API/client/MCP are storage-free; `substrate/` renders plugin assets.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client; compat/storage/UI/harness do not import inward.
- One npm11 lock; `packages/persistence` is the sole SQLite writer, recovery owner, and migration owner.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; exceptional close is server-composed.
- `CommandGateway` atomically writes tracker/management mutations, GOL-79 receipts, invalidations, settlement, and direct-core effects. Replays are inert; changed keys return `409`; semantic changes publish once; scope filtering precedes WS; HTTP revisions are truth.
- `TicketDispatchService` is the browser/bearer/MCP delivery seam. The current assignee must resolve fail-closed to an eligible active generation; GOL-79 queues `tracker_envelopes` as `ready`/`pull_only`/`next_turn`. Terminal/ineligible writes create none; stale CAS replays. Historical/runtime fields never select; only server-authenticated MCP exposes legacy alias/content, and durable binding—not credential spelling—defines provenance.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS. Browser work uses generated paths, same-origin cookie reads/WS, CSRF commands, and a metadata-only synchronizer that replaces snapshots and refetches every invalidation; it accepts no browser authority or domain merge. GOL-80 scopes opaque frames before construction; foreign detail is absent.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Projections read canonical rows only; diagnostics and WS invalidations are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, named journeys, render, and `git diff --check`.
