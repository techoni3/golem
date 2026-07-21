# REPO-MAP.md
> Last verified: 2026-07-21 @ 607d633 — maintained via golem:docs-maintenance.

## Structure

- `apps/` holds private composition (CLI, Fastify control plane, typed shell); `dashboard/web` is the legacy island.
- `packages/` holds contracts, persistence, runtime/tracker, compat, compiler, MCP, API client, testkit, UI, and typed adapters. OpenCode's typed boundary is `packages/adapters/opencode/src/`; `shims/opencode/` is the compatibility host delegate.
- `apps/control-plane/src/api-v1.ts` is the authenticated tracker/delivery/bus API; `tracker-core-routes.ts` is its legacy delegate. Generated API client and MCP are storage-free.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy dashboard root is authoritative; typed static output is parallel.

## Invariants and flow

- Flow is contracts → domain/runtime/tracker → control plane → generated API client → clients; canonical layers exclude compatibility/storage/UI/harness/tool imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; the owner handles recovery/quarantine/replay.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services. Exceptional close is server-composed `{id, expectedRevision, reason}`.
- Launcher owns fail-closed writes and immutable LaunchPlan launchability/delivery facts; the CLI registry owns parser/help/metadata. OpenCode consumes those facts but never authorizes launch from delivery readiness.
- Control plane owns REST/WS; bearer is CLI/MCP-only and browser reads are same-origin/CSRF-protected. API client owns validation/resync.
- Project identity uses canonical Git paths; sessions are project-first with immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic outbox effects.
- Runtime projections read canonical rows only: live excludes terminal generations; diagnostics are redacted/bounded; reads never mutate; HTTP/WS share revision/cursor facts.
- Migration re-audits an exact plan hash under a home lock, refuses review/quarantine before mutation, snapshots source + canonical state, and exports a generated read-only projection. Rollback restores the canonical snapshot.
- OpenCode setup changes only marked provider config; native lifecycle becomes typed signals. Prompt delivery must recheck generation/fence/eligibility, and child sessions are never dispatchable.
- Endpoint claims are generation/route scoped: fences gate heartbeat, health, readiness, capability, delivery, and release; eligibility returns stable redacted facts and registration alone never qualifies delivery.
- Typed management owns roles, gates, ideas, assets, communications, controls, audit, and outbox; routes cannot open SQLite or mutate runtime lifecycle.
- Typed mutators require caller project/session/actor headers; delivery rechecks generation/fence/readiness/capability before transport.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, lint, named journeys, render, and `git diff --check`.
