# REPO-MAP.md
> Last verified: 2026-07-20 @ 4058f1b — maintained via golem:docs-maintenance.

## Structure

- `apps/` are private TypeScript composition; legacy entrypoints stay authoritative until their vertical cutover.
- `packages/`: `contracts` schemas; `domain` pure policy; `persistence` SQLite writer; `runtime`/`tracker` services; `launcher` redacted plans; `compat` legacy seams; `compiler` renders; `mcp-adapter` schema/API delegation; `api-client` generated types; `testkit` journeys; `ui` tokens/React Aria.
- `tools/openapi-codegen/` is isolated TS5 generation, never runtime packaging. `substrate/` is source; `plugin/` and `dashboard/dist/` are generated. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Invariants

- One npm11 lock owns workspace code. Apps use TS7; `api-client` owns `openapi-fetch`; codegen pins TS5.9.3. Root scripts own build/typecheck/boundaries/lint and generation.
- Direction is contracts → domain/runtime/tracker → control-plane → client → CLI/MCP/dashboard. Canonical code never imports compatibility, storage, UI, harness, or tools; `scripts/check-boundaries.mjs` enforces this.
- `persistence` alone opens SQLite writers; runtime/tracker DBs remain separate. `launcher` owns fail-closed preset resolution, redacted JSONC backup/temp/commit/rollback, trusted native discovery, and `shell:false` execution.
- `compat` is never authoritative: GOL-39 uses stable no-follow descriptor snapshots, per-component containment, one global 5k inventory, and redacted/hashed paths. Apply/import is deferred; unsafe or unresolved evidence never auto-links.
- `apps/control-plane` is foreground Fastify composition. Typed `/api/v1/ws` accepts bearer CLI/MCP callers; browser sessions are bounded HttpOnly/Origin/Host/protocol/port; headerless legacy `/ws` has an injected source only.

## Data flow and gotchas

Hooks/shims write below `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Contract aliases enter domain, which leaves unresolved evidence for review. `testkit` owns temp homes, child cleanup, stable summaries, semantic comparison, and headless fixtures; sandbox loopback denial is `UNMET`.

- Nested `mcp/channel` postinstall/lock is the live GOL-29 render closure; its relocatable artifact is deferred, not `.mcp.json`'s entrypoint. See `docs/architecture/render-mcp-closure.md` for J1.
- Never peer-bypass, import `tools/**` from production, ship workspace symlinks/TS5, or hand-edit generated renders. Claude updates cached render bytes only after sync/update/reload.

## Common tasks

| Task | Verify |
|---|---|
| Workspace | Node24 build/typecheck/boundaries/lint |
| Render/MCP | `npm run verify:render` (J1) |
| Domain/persistence | `test:domain` (J2), `test:persistence` (J3) |
| Launcher | `test:launcher-resolution`, J5/J7 |
| Legacy audit | `migration:plan`, `test:migration-plan` (J7) |
| Legacy runtime | temp-home legacy baseline |
