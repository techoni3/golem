# REPO-MAP.md
> Last verified: 2026-07-20 @ 058b75c + GOL-38 composed-system correction — maintained via golem:docs-maintenance.

## Structure

- `apps/`: private TypeScript composition. `control-plane` is Fastify; `dashboard` is the React 19/Vite 8/Router 7/Query 5 typed shell. `dashboard/web` supplies current page-body/drawer compatibility seams, never typed routing ownership.
- `packages/`: contracts; pure domain; SQLite persistence; runtime/tracker; launcher; compat; compiler; MCP adapter; generated `api-client`; real-process `testkit`; UI. `tools/openapi-codegen/` pins TS5.9.3 only; apps use TS7.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. The root `dashboard/dist/` remains the legacy `golem dashboard` artifact; the typed control-plane shell is the parallel `dashboard/dist/control-plane/` root. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` remain compatibility surfaces.

## Invariants and flow

- Direction: contracts → domain/runtime/tracker → control-plane → api-client → CLI/MCP/dashboard. Canonical code never imports compatibility, storage, UI, harnesses, or tools; `scripts/check-boundaries.mjs` enforces it.
- One npm11 lock. `persistence` alone opens SQLite writers; runtime/tracker databases are separate. Runtime producers use a spool only; service owns recovery, atomic facts/outbox and quarantine. Tracker owns durable delivery/claim/replay/retention.
- Launcher owns fail-closed redacted JSONC writes, trusted native discovery, shell-free argv/env, readiness timeouts, and child groups. `compat` is non-authoritative: GOL-39 descriptor snapshots, containment, one 5k cap, and redacted/hashed paths leave unsafe evidence in review.
- Control plane owns REST/WS. `/api/v1/ws` uses bearer for CLI/MCP; browser sessions are bounded by loopback Host/protocol/port, exact same-origin Origin for mutation bootstrap, and CSRF thereafter. Browser reads retain the documented fallback; dashboard code receives no bearer.
- `api-client` owns generated HTTP, WS validation, epoch snapshots, ordered deltas, gap/instance resync, and the reducer helpers consumed by the dashboard Query cache. The typed dashboard owns the sole Router/history/navigation/focus/overlay lifecycle; the island replays a projection into selected real legacy bodies and drawers only.

## Gotchas and checks

- Tests use disposable homes: never mutate user state, shared dashboard ports, Docker, or renders from a ticket worktree. Sandbox loopback denial is `UNMET`, never PASS.
- The live nested `mcp/channel` closure remains the GOL-29 render entrypoint; the relocatable artifact is deferred. Do not hand-edit generated renders or peer-bypass/ship workspace symlinks or TS5.
- Node24 checks: `typecheck`, `check:boundaries`, `lint`; render `verify:render`; J2 domain, J3 runtime, J4 delivery/legacy, J5 launcher, J6 control-plane/dashboard, J7 launcher resolution/migration. Dashboard: `test:browser -- --grep dashboard-shell` and `test:journey -- --scenario ws-gap-resync`.
