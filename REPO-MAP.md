# REPO-MAP.md
> Last verified: 2026-07-21 @ 30c4fd9 — maintained via golem:docs-maintenance.

## Structure

- `apps/` holds private composition (CLI, Fastify control plane); `dashboard/web` is the legacy island.
- `packages/` holds typed domain layers, clients, testkit, UI, and adapters. Codex managed App Server/TUI transport is under `packages/adapters/codex/src/managed/`; `lib/codex-supervisor.js` is only a lazy compatibility delegate. OpenCode's boundary is `packages/adapters/opencode/src/`; its shim is the compatibility host. Claude's boundary is `packages/adapters/claude/src/`, which consumes canonical ports without storage authority.
- `packages/adapters/claude` owns Claude hook-to-signal codecs, fenced channel ownership, addressed consumption qualification, and render/launch contributions; it is storage-free and consumes injected canonical ports.
- `packages/adapters/pi` is the Pi control boundary. It requires a strong supplied binding before a raw Pi id can become canonical lifecycle or delivery state.
- `apps/control-plane/src/api-v1.ts` is authenticated tracker/delivery/bus; `tracker-core-routes.ts` is legacy. Generated client and MCP are storage-free.
- `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated. Legacy dashboard remains authoritative.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; exceptional close is server-composed.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI registry owns grammar. OpenCode changes only marked config; direct launch stays pull-only until fenced.
- Control plane owns REST/WS; bearer is CLI/MCP-only and browser reads are same-origin/CSRF-protected. API client owns validation/resync.
- Project identity is canonical Git paths; sessions are project-first with immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Runtime projections read canonical rows only; diagnostics are redacted/bounded; HTTP/WS share revision/cursor facts.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Typed mutators require caller project/session/actor headers; delivery rechecks generation/fence/readiness/capability before transport.
- Managed Codex is launchable only for qualified OpenAI/GPT. It emits canonical signals and rechecks endpoint eligibility before each turn; launchability never substitutes for fenced consumer readiness. Local/OSS fails pre-spawn with a direct-Codex remedy.
- Pi is pull/next-turn only: it claims only on real Pi input and turns dead-letter/retry diagnostics into stable redacted categories. Unbound legacy rows remain diagnostic.
- Migration audits an exact plan hash under a home lock, refuses review/quarantine before mutation, snapshots source + canonical state, and exports a read-only projection.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, lint, named journeys, render, and `git diff --check`.
