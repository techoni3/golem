# REPO-MAP.md
> Last verified: 2026-07-21 @ c284d34 — maintained via golem:docs-maintenance.

## Structure

- `apps/` holds private composition (CLI, Fastify control plane, typed shell); `dashboard/web` remains the legacy island.
- `packages/` holds contracts, domain, SQLite persistence, runtime/tracker, launcher, compat, compiler, MCP, generated API client, testkit, and UI. Sessions live in `packages/runtime/src/sessions/` + `packages/persistence/src/session-repository.ts`; endpoint fencing/readiness in `packages/runtime/src/endpoints/` + `packages/persistence/src/endpoint-repository.ts`.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. The legacy dashboard root remains authoritative; typed control-plane static output is parallel.

## Invariants and flow

- Flow is contracts → domain/runtime/tracker → control plane → generated client → clients; boundaries keep canonical layers free of compatibility, UI, harness, and tool imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool and the owner handles recovery/quarantine/outbox replay.
- Tracker owns durable delivery and typed work-item/phase services; exceptional close is server-composed `{id, expectedRevision, reason}`.
- Launcher owns fail-closed writes, shell-free process groups, and immutable LaunchPlan facts; the CLI registry owns parser/help/metadata.
- Control plane owns REST/WS; bearer is CLI/MCP-only. Browser bootstrap is same-origin/CSRF-protected; `api-client` owns generated validation/resync.
- Project identity uses canonical Git paths and retains relocation UUIDs; runtime observations are transactional and deduplicated.
- Sessions are project-first with immutable generations, scoped aliases, provenance ordering, terminal monotonicity, and deterministic outbox effects.
- Endpoint claims are generation/route scoped: integer fences supersede owners; lease, health, probe, readiness, capability, delivery, and release mutations require the current fence. Eligibility returns stable redacted facts/reasons; registration alone never qualifies delivery.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`, never PASS.
- `mcp/channel` remains the GOL-29 render entrypoint; do not hand-edit generated renders or bypass workspace boundaries.
- Node24 gates cover build/typecheck, boundaries, lint, render, and named J2–J7 journeys, plus `git diff --check`.
