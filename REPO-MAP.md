# REPO-MAP.md
> Last verified: 2026-07-21 @ 63e3ec7 — maintained via golem:docs-maintenance.

## Structure

- `apps/` holds private composition (CLI, Fastify control plane, typed shell); `dashboard/web` is the legacy island.
- `packages/` holds contracts, domain, SQLite persistence, runtime/tracker, launcher, compat, compiler, MCP, generated API client, testkit, and UI. Sessions live in `packages/runtime/src/sessions/` + `packages/persistence/src/session-repository.ts`; endpoint fences in `packages/runtime/src/endpoints/` + `packages/persistence/src/endpoint-repository.ts`; runtime projections in `packages/runtime/src/projections.ts` over the typed `packages/persistence/src/runtime-projection-repository.ts` capability.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy dashboard root is authoritative; typed static output is parallel.

## Invariants and flow

- Flow is contracts → domain/runtime/tracker → control plane → generated API client → clients; canonical layers exclude compatibility/storage/UI/harness/tool imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; the owner handles recovery/quarantine/replay.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services. Exceptional close is server-composed `{id, expectedRevision, reason}`.
- Launcher owns fail-closed writes and immutable LaunchPlan launchability/delivery facts; the CLI registry owns parser/help/metadata.
- Control plane owns REST/WS; bearer is CLI/MCP-only. Browser bootstrap is same-origin/CSRF-protected; `api-client` owns generated validation/resync. Runtime reads are authenticated at `/api/v1/runtime/{live,history,diagnostics}` and typed WS.
- Project identity uses canonical Git paths; sessions are project-first with immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic outbox effects.
- Runtime projections read canonical SQLite rows only: live excludes terminal generations, history retains lifecycle facts, diagnostics are recursively redacted/bounded, observation stays separate from actor activity, and reads never mutate state. HTTP/WS share revision/cursor facts.
- Endpoint claims are generation/route scoped: fences gate heartbeat, health, readiness, capability, delivery, and release; eligibility returns stable redacted facts and registration alone never qualifies delivery.
- Typed management (`packages/tracker/src/management.ts`) owns roles, gates, ideas, assets, communications, controls, audit, and outbox; routes cannot open SQLite, mutate runtime lifecycle, or deliver native transport.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates cover build/typecheck, boundaries, lint, named journeys, and `git diff --check`.
