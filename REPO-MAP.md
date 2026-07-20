# REPO-MAP.md
> Last verified: 2026-07-20 @ e69f622 + GOL-37 execution boundary — maintained via golem:docs-maintenance.

## Structure

- `apps/` compose private TypeScript seams; legacy entrypoints stay authoritative until a vertical-slice cutover.
- `packages/` flow strictly: `contracts` schemas → `domain` pure policy → `persistence` single SQLite writer → `runtime`/`tracker` services → control plane/client/CLI/MCP/dashboard. `testkit` and journeys prove real boundaries.
- `tools/openapi-codegen/` is isolated TS5 codegen, never production; `substrate/` is source while `plugin/` and `dashboard/dist/` are generated products.

## Contracts and data flow

- Root npm 11 lock owns all workspaces. Applications use TS7; codegen alone pins TS5.9.3 and OpenAPI Typescript 7.13.0. Never peer-bypass or import `tools/**` from production.
- `persistence` owns private SQLite/Kysely, checked migrations, backup/recovery, injected clock, typed schema, and bounded outboxes. Writer construction is control-plane-only.
- `runtime` gives producers only a filesystem spool. The service owns lease/attempt recovery, no-clobber archive or redacted quarantine, atomic facts/watermarks/outbox, and bounded materializer+outbox health; producer processes never open SQLite.
- The control plane owns typed `/api/v1`, browser/bearer authority, `/api/v1/ws`, static legacy dashboard, and headerless legacy `/ws`. Legacy dashboard/server code is compatibility, not a canonical package dependency.
- `tracker` receives typed storage/eligibility ports only; it never treats a JSON registry as endpoint authority.
- `launcher` owns redacted qualified-plan execution: trusted binary discovery, shell-free argv/environment, readiness-gated automatic timeout, and owned child groups. See `docs/architecture/launcher-execution.md` (J5).

## Constraints

- `GOLEM_HOME` holds runtime state. Tests use disposable homes; do not write user state, shared dashboard ports, Docker resources, or rendered plugin outputs from a ticket worktree.
- `mcp/channel` has its own lock/postinstall until GOL-29 cutover; the relocatable render artifact is separately verified.
- TS7 builds use `--stopBuildOnErrors`; generated OpenAPI is deterministic and must match the pinned CLI.

## Common tasks

| Task | Verify with |
|---|---|
| Workspace/boundaries | Node 24 `typecheck`, `check:boundaries`, `lint` |
| Persistence J3 | `test:persistence`, `sqlite-owner-migration-recovery` |
| Runtime J3/J1 | `test:runtime-engine`, distinct `materializer-crash-matrix` and `dashboard-down-inbox-replay` |
| Control plane J6 | `api:check`, `control-plane-auth-ws-lifecycle` |
| Render/MCP J1 | `verify:render` |
