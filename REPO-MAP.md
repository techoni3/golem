# REPO-MAP.md
> Last verified: 2026-07-23 @ 053be8e — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply` under `GOLEM_HOME`; completions/aliases never edit shell RC files.
- `packages/` contains typed domain/client/testkit/UI/adapters. Managed Codex transport is storage-free; OpenCode, Claude, and Pi consume canonical ports.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. Typed API, generated client, and MCP are storage-free. `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays and owns managed migrations.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; managed migrations own phase-evidence relations such as comment dispatches; exceptional close is server-composed.
- One typed `CommandGateway` routes tracker/management mutations through one SQLite transaction and persists a durable receipt/outcome per `(project_id, idempotency_key)` (`tracker/007`); replay has no side effect and changed reuse is `409 command.idempotency_mismatch`. `tracker/008` trigger-owned opaque invalidations share that commit, delivery settlement, and direct-core writes; the dispatcher scope-filters before WS framing and HTTP revisions remain truth.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS. Its BrowserPrincipalResolver resolves durable opaque browser/bearer/MCP/internal bindings, scopes, expiry, and revocation into generic ActorContext; no request actor/role/project/fence/approval/storage field is authority. Missing binding is 401; policy denial is 403; foreign detail/commands are non-disclosing.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Projections read canonical rows only; diagnostics and WS invalidations are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, named journeys, render, and `git diff --check`.
