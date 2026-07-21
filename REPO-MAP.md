# REPO-MAP.md
> Last verified: 2026-07-21 @ 55c1735 — maintained via golem:docs-maintenance.

## Structure

- `apps/` holds private CLI/control-plane composition; `dashboard/web` is the legacy island. `managed-codex-control.ts` owns durable runtime/tracker ports for the foreground managed-Codex host.
- `packages/` holds typed domain, client, testkit, UI, and adapter layers. Managed Codex App Server/TUI transport is storage-free under `packages/adapters/codex/src/managed/`; `lib/codex-supervisor.js` is a lazy compatibility delegate. OpenCode, Claude, and Pi each consume injected canonical ports.
- `apps/control-plane/src/api-v1.ts` is authenticated tracker/delivery/bus; `tracker-core-routes.ts` is legacy. Generated client and MCP are storage-free.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy dashboard remains authoritative.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; exceptional close is server-composed.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI owns grammar. Direct launch stays pull-only until fenced.
- Control plane owns REST/WS; bearer is CLI/MCP-only and browser reads are same-origin/CSRF-protected. API client owns validation/resync.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Projections read canonical rows only; diagnostics are redacted/bounded; HTTP/WS share revision/cursor facts.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Typed mutators require caller project/session/actor headers; delivery rechecks generation/fence/readiness/capability before transport.
- Managed Codex is OpenAI/GPT-only; `golem codex` starts the control-plane-owned host, whose adapter emits signals and fences durable sends. Local/OSS fails pre-spawn with the direct-Codex remedy.
- Pi is pull/next-turn only; unbound legacy rows remain diagnostic.
- Migration audits an exact plan hash under a home lock, refuses review/quarantine before mutation, snapshots source + canonical state, and exports a read-only projection.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, lint, named journeys, render, and `git diff --check`.
