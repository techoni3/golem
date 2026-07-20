# REPO-MAP.md
> Last verified: 2026-07-21 @ 99f1682 — maintained via golem:docs-maintenance.

## Structure

- `apps/` contains private TypeScript composition: CLI registry, Fastify control plane, and typed dashboard shell. `dashboard/web` remains the legacy body/drawer island.
- `packages/` contains contracts, pure domain, SQLite persistence, runtime/tracker services, launcher, compat, compiler, MCP, generated API client, testkit, and UI. Runtime session materialization is split between `packages/runtime/src/sessions/` and `packages/persistence/src/session-repository.ts`.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy `dashboard/dist/` remains the `golem dashboard` root; the typed control-plane root is parallel.

## Invariants and flow

- Flow is contracts → domain/runtime/tracker → control plane → generated API client → clients. Canonical layers do not import compatibility, storage, UI, harnesses, or tools; boundaries enforce this.
- One npm11 lock. `packages/persistence` alone opens SQLite writers. Producers spool; the owner handles recovery, quarantine, and durable outbox replay.
- Tracker owns durable delivery, claim/replay/retention, and typed work-item/phase/comment/link/stream services. Exceptional close is server-composed `{id, expectedRevision, reason}`; request text and generic MCP input never authorize it.
- Launcher owns fail-closed writes, shell-free process groups, and immutable LaunchPlan launchability/delivery facts; compat is non-authoritative. The CLI registry is the one parser/help/metadata vocabulary.
- Control plane owns REST/WS; bearer is CLI/MCP-only. Browser bootstrap is same-origin/CSRF-protected and typed dashboard code receives no bearer. `api-client` owns generated validation and resync.
- Project identity uses canonical real paths plus Git common-dir/worktree evidence; relocation history retains UUIDs. Runtime observations are one-owner transactional and deduplicated.
- Logical sessions are project-first: immutable generations, scoped aliases, source-time/tie provenance, terminal monotonic lifecycle, monotonic actor activity, observation timestamps, and deterministic ordered outbox effects are materialized by `SessionService`.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`, never PASS.
- `mcp/channel` remains the GOL-29 render entrypoint. Do not hand-edit generated renders, peer-bypass workspace symlinks, or TS5 topology.
- Node24 checks cover build/typecheck, boundaries, lint, render, and named J2–J7 journeys. Session evidence is `npm run test:sessions`, `npm run test:journey -- --scenario cross-harness-session-lifecycle`, and `npm run test:journey -- --scenario session-reorder-restart-replay`, plus `git diff --check`.
