# REPO-MAP.md
> Last verified: 2026-07-21 @ 7bc1544 — maintained via golem:docs-maintenance.

## Structure

- `apps/`: private TypeScript composition; Fastify control-plane and typed dashboard shell. `dashboard/web` remains a narrow body/drawer island.
- `packages/`: contracts, domain, persistence, runtime/tracker, launcher, compat, compiler, MCP, generated client, real-process testkit, and UI. `runtime/src/projects` owns Git/filesystem evidence and typed project/location materialization. Apps use TS7; only `tools/openapi-codegen/` uses TS5.9.3.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy `dashboard/dist/` stays the `golem dashboard` root; typed control-plane is parallel under `dashboard/dist/control-plane/`.

## Invariants and flow

- Direction: contracts → domain/runtime/tracker → control-plane → api-client → clients. Canonical code never imports compatibility, storage, UI, harnesses, or tools; boundaries enforce this.
- One npm11 lock. `persistence` alone opens SQLite writers; runtime/tracker DBs are separate. Producers spool; service owns recovery/quarantine.
- `tracker` owns durable delivery/claim/replay/retention plus typed work-item, phase, comment, link, and stream services through storage/eligibility ports. Its legacy façade maps payloads but owns neither a DB nor runtime-readiness authority.
- Exceptional close is server-composed `{id, expectedRevision, reason}`; request actors/comments/skip text never authorize it, and generic MCP rejects unverified closes.
- Launcher owns fail-closed JSONC writes, trusted discovery, shell-free argv/env, timeouts, and child groups. `compat` is non-authoritative and quarantines unsafe evidence.
- Control plane owns REST/WS; bearer is for CLI/MCP only. Browser mutation bootstrap is same-origin and CSRF-protected; dashboard code receives no bearer.
- `api-client` owns generated HTTP/WS validation, epoch resync, and Query reducer helpers. Typed dashboard owns Router/history/focus/overlay lifecycle; islands only replay selected legacy bodies.
- Tracker core uses `tracker/003-live-tracker-core` over canonical rows/events. CAS/outbox/audit derive from `events.id`; dashboard attaches a migration-neutral capability after opening its legacy tracker. Unmanaged files stay byte-preserved until explicit migration.
- Project identity uses canonical real paths plus Git common-dir/worktree evidence. Git roots auto-register; non-Git paths require `.golem-project` or explicit registration. Runtime project observations are deduplicated in one owner transaction and emit management outbox evidence; relocations retain/retire locations without changing UUIDs.

## Gotchas and checks

- Tests use disposable homes: never mutate user state, shared dashboard ports, Docker, or renders from a ticket worktree. Sandbox loopback denial is `UNMET`, never PASS.
- The live nested `mcp/channel` closure remains the GOL-29 render entrypoint; the relocatable artifact is deferred. Do not hand-edit generated renders or peer-bypass/ship workspace symlinks or TS5.
- Node24 checks: typecheck/boundaries/lint; render verify; J2 domain, J3 persistence, J4 tracker, J5 launcher, J6 dashboard, J7 resolution/migration.
- Tracker core: `test:tracker-core` and `test:journey -- --scenario tracker-core-compatibility`. Dashboard: `test:browser -- --grep dashboard-shell` and `test:journey -- --scenario ws-gap-resync`.
