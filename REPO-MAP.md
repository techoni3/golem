# REPO-MAP.md
> Last verified: 2026-07-23 @ GOL-79 worktree (b55dff8) — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply` under `GOLEM_HOME`; completions/aliases never edit shell RC files.
- `packages/` contains typed domain/client/testkit/UI/adapters. Managed Codex transport is storage-free; OpenCode, Claude, and Pi consume canonical ports.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. Typed API, generated client, and MCP are storage-free. `substrate/` is render source; `plugin/` and `dashboard/dist/` are generated.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client → clients; it excludes compat/storage/UI/harness imports.
- One npm11 lock; `packages/persistence` is the sole SQLite writer. Producers spool; its owner recovers/quarantines/replays and owns managed migrations.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; managed migrations own phase-evidence relations such as comment dispatches; exceptional close is server-composed.
- One typed `CommandGateway` (`packages/tracker/src/gateway.ts`) routes tracker/management mutations through one canonical SQLite transaction and persists a durable receipt/outcome per `(project_id, idempotency_key)` (`tracker/007-command-receipts`); restart-safe replay returns the original typed outcome with no side effect; a reused key with a differing payload returns `409 command.idempotency_mismatch`. Adapters only translate transport; receipt rows carry only a SHA-256 fingerprint — never bearer/cookie/CSRF/prompt/fence/path.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS. Its BrowserPrincipalResolver resolves durable opaque browser/bearer/MCP/internal bindings, scopes, expiry, and revocation into generic ActorContext; no request actor/role/project/fence/approval/storage field is authority. Missing binding is 401; policy denial is 403; foreign detail/commands are non-disclosing.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- The rendered Codex `SessionStart` hook additively upserts `projects.json` (`kind:"auto"`, `registered_by:"hook"`) and a matching `sessions.json` row from the resolved contract root; repeat registration refreshes timestamps only and preserves a manual name/kind. Non-SessionStart Codex events retain `lib/session-facts.js` writes and do not register rows. The hook is fail-open; the generated render is the contract source.
- Projections read canonical rows only; diagnostics are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness and prevents duplicate turns. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock before mutation.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `mcp/channel` is the GOL-29 render entrypoint; do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, lint, named journeys, render, and `git diff --check`.
