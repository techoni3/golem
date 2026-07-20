# REPO-MAP.md
> Last verified: 2026-07-20 @ a1bf377 + GOL-39 reconciliation — maintained via golem:docs-maintenance.

## Structure

- `apps/` are private TypeScript composition; legacy entrypoints stay authoritative until their vertical cutover.
- `packages/`: `contracts` schemas; `domain` pure policy; `persistence` SQLite writer; `runtime`/`tracker` services; `launcher` redacted plans and owned child processes; `compat` legacy seams; `compiler` renders; `mcp-adapter` schema/API delegation; `api-client` generated types; `testkit` journeys; `ui` tokens/React Aria.
- `tools/openapi-codegen/` is isolated TS5 generation, never runtime packaging. `substrate/` is source; `plugin/` and `dashboard/dist/` are generated. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Invariants

- One npm11 lock owns workspace code. Apps use TS7; `api-client` owns `openapi-fetch`; codegen pins TS5.9.3. Root scripts own build/typecheck/boundaries/lint and generation.
- Direction is contracts → domain/runtime/tracker → control-plane → client → CLI/MCP/dashboard. Canonical code never imports compatibility, storage, UI, harness, or tools; `scripts/check-boundaries.mjs` enforces this.
- `persistence` alone opens SQLite writers; runtime/tracker DBs remain separate. It owns checked migrations, backup/recovery, injected clocks, typed schemas, and bounded outboxes.
- `runtime` gives producers only a filesystem spool. The service owns lease/attempt recovery, no-clobber archive or redacted quarantine, atomic facts/watermarks/outbox, and bounded materializer/outbox health; producer processes never open SQLite.
- `tracker` owns durable envelope claim/settlement authority, semantic idempotency, bus event/cursor replay, passive slot leases, and dependency-aware retention through typed storage/eligibility ports only; a JSON registry is never endpoint authority.
- `launcher` owns fail-closed preset resolution, redacted JSONC backup/temp/commit/rollback, trusted native discovery, shell-free argv/environment, readiness-gated automatic timeout, and owned child groups. See `docs/architecture/launcher-execution.md` (J5).
- `compat` is never authoritative: GOL-39 uses stable no-follow descriptor snapshots, per-component containment, one global 5k inventory, and redacted/hashed paths. Apply/import is deferred; unsafe or unresolved evidence never auto-links.
- `apps/control-plane` is foreground Fastify composition. Typed `/api/v1/ws` accepts bearer CLI/MCP callers; browser sessions are bounded HttpOnly/Origin/Host/protocol/port; headerless legacy `/ws` has an injected source only.

## Data flow and gotchas

Hooks and shims write below `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Contract aliases enter domain, which leaves unresolved evidence for review. `testkit` owns temp homes, child cleanup, stable summaries, semantic comparison, and headless fixtures; sandbox loopback denial is `UNMET`.

- Tests use disposable homes; never write user state, shared dashboard ports, Docker resources, or rendered plugin outputs from a ticket worktree.
- Nested `mcp/channel` postinstall/lock is the live GOL-29 render closure; its relocatable artifact is deferred, not `.mcp.json`'s entrypoint. See `docs/architecture/render-mcp-closure.md` for J1.
- Never peer-bypass, import `tools/**` from production, ship workspace symlinks/TS5, or hand-edit generated renders. Claude updates cached render bytes only after sync/update/reload.
- TS7 builds use `--stopBuildOnErrors`; generated OpenAPI is deterministic and must match the pinned CLI.

## Common tasks

| Task | Verify |
|---|---|
| Workspace | Node24 `typecheck`, `check:boundaries`, `lint` |
| Render/MCP | `verify:render` (J1) |
| Domain/persistence | `test:domain` (J2), `test:persistence` (J3) |
| Runtime | `test:runtime-engine`, `materializer-crash-matrix`, `dashboard-down-inbox-replay` (J3/J1) |
| Tracker delivery | `test:delivery-bus`, `delivery-queue-crash-matrix`, `bus-offline-replay` (J4) |
| Launcher resolution/process | `test:launcher-resolution`, `test:launcher-process`, J5/J7 |
| Legacy audit/migration | `migration:plan`, `test:migration-plan`, `migration-dry-run-ambiguity` (J7) |
| Control plane | `api:check`, `control-plane-auth-ws-lifecycle` (J6) |
| Legacy runtime | temp-home legacy baseline |
