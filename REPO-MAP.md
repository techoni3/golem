# REPO-MAP.md
> Last verified: 2026-07-20 @ 2f152bc — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints are authoritative until cutover.
- `packages/` — `contracts` owns Zod v1 schemas, `api-client` generated `openapi-fetch`, `ui` primitives, and `testkit`/`test/journeys/` real-process proof.
- `tools/openapi-codegen/` — private TS5 generator, never runtime/public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Workspace

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- Root scripts own typecheck/build/boundaries/lint/clean and deterministic `contracts:*`/`api:*` generation/check.
- `api-client` uses runtime `openapi-fetch@0.17.0`; codegen alone has exact TS 5.9.3/OpenAPI Typescript 7.13.0. No application/runtime source imports the tools workspace.
- `testkit` contains temp homes, child cleanup, summaries, and headless contexts; denied loopback is `UNMET`.
- `apps/control-plane` is the thin foreground Fastify composition façade. Its authenticated typed replay is `/api/v1/ws`: bearer CLI/MCP callers need no Origin, while bounded HttpOnly browser sessions require an exact request Origin/Host/protocol/port match; headerless legacy `/ws` is fed only by an injected compatibility source. Separate modules keep that policy, strict errors, durable LaunchAgent swap, and static shell isolated (`docs/architecture/control-plane.md`).

### `scripts/check-boundaries.mjs`

- Reads dependency metadata/imports including root JS/MJS, normalizing `@golem/*` subpaths before direction checks.
- Its nine fixtures cover metadata-only, compat-subpath, and root-level codegen MJS cases.

## Data flow and constraints

Hooks/shims write below `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. The control-plane shell exposes typed `/api/v1` plus `/api/v1/ws`, while preserving headerless legacy `/ws` and static compatibility only; it neither imports legacy dashboard state nor migrates runtime/tracker routes. Direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compat, storage, UI, harness, or tools.

- Nested `mcp/channel` postinstall/lock is the declared temporary GOL-29 legacy closure, not a second canonical lock.
- Never peer-bypass, import `tools/**` from production, or include workspace symlinks/TS5 in the root tarball. TS 7 uses `--stopBuildOnErrors`.

## Common tasks

| Task | Files | Verify with |
|---|---|---|
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, typecheck/build, boundaries, lint |
| Control plane | `apps/control-plane`, `packages/api-client`, J6 | Node 24 `api:generate`, `api:check`, J6, browser shell |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
