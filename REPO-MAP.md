# REPO-MAP.md
> Last verified: 2026-07-21 @ 2833e4d — maintained via golem:docs-maintenance.

## Structure

- `apps/`: private TypeScript composition; typed CLI registry, Fastify control-plane, and typed dashboard shell. `dashboard/web` remains a body/drawer island.
- `packages/`: contracts, domain, persistence, runtime/tracker, launcher, compat, compiler, MCP, generated client, real-process testkit, and UI. Apps use TS7; only `tools/openapi-codegen/` uses TS5.9.3.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy `dashboard/dist/` remains the `golem dashboard` root; typed control-plane is parallel.

## Invariants and flow

- Direction is contracts → domain/runtime/tracker → control-plane → api-client → clients. Canonical code never imports compatibility, storage, UI, harnesses, or tools; boundaries enforce this.
- One npm11 lock. `packages/persistence` alone opens SQLite writers; runtime/tracker DBs are separate. Producers spool; the owner handles recovery/quarantine.
- `packages/tracker` owns durable delivery/claim/replay/retention plus typed work-item, phase, comment, link, and stream services. Its legacy façade owns no DB or runtime-readiness authority.
- Exceptional close is server-composed `{id, expectedRevision, reason}`; request text/comments/MCP input never authorize it. Launcher owns fail-closed writes, shell-free process groups, and the immutable LaunchPlan launchability/delivery split; compat is non-authoritative.
- Control plane owns REST/WS; bearer is CLI/MCP-only. Browser mutation bootstrap is same-origin/CSRF-protected; dashboard code receives no bearer. `api-client` owns generated validation/resync; typed dashboard owns UI lifecycle.
- Tracker core uses canonical rows/events; CAS/outbox/audit derive from event ids and legacy state remains byte-preserved until migration. Project identity uses canonical real paths plus Git/worktree evidence and retains UUIDs across relocation.
- `apps/cli/src/registry.ts` is the one Commander vocabulary for parser/help/metadata; `cli/golem.js` delegates harness dry-runs through `dist/apps/cli/`.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Sandbox loopback denial is `UNMET`, never PASS.
- `mcp/channel` remains the GOL-29 render entrypoint. Do not hand-edit generated renders, peer-bypass workspace symlinks, or TS5 topology.
- Node24 checks cover typecheck, boundaries, lint, render, and J2–J7 journeys. Focused project checks are `npm run test:launcher-resolution`, the named launcher `test:journey` scenarios, `npm run check:boundaries`, and `git diff --check`.
