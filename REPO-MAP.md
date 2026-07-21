# REPO-MAP.md
> Last verified: 2026-07-21 @ b44227c — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply` under `GOLEM_HOME`; completions/aliases never edit shell RC files.
- `packages/` holds typed domain, client, testkit, UI, and adapter layers. Managed Codex App Server/TUI transport is storage-free under `packages/adapters/codex/src/managed/`; OpenCode, Claude, and Pi consume injected canonical ports.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. `api-v1.ts` is authenticated tracker/delivery/bus; `tracker-core-routes.ts` is legacy. Generated client and MCP are storage-free. `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; managed migrations own phase-evidence relations such as comment dispatches; exceptional close is server-composed.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS; bearer is CLI/MCP-only and browser reads are same-origin/CSRF-protected.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- The rendered Codex `SessionStart` hook additively upserts `projects.json` (`kind:"auto"`, `registered_by:"hook"`) and a matching `sessions.json` row from the resolved contract root; repeat registration refreshes timestamps only and preserves a manual name/kind. Non-SessionStart Codex events retain `lib/session-facts.js` writes and do not register rows. The hook is fail-open; the generated render is the contract source.
- Projections read canonical rows only; diagnostics are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery. Typed mutators require caller project/session/actor headers.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness and prevents duplicate turns. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock before mutation.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, lint, named journeys, render, and `git diff --check`.
