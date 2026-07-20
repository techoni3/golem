# REPO-MAP.md
> Last verified: 2026-07-20 @ ae007f4 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints are authoritative until cutover.
- `packages/` — `contracts` owns Zod v1 schemas, `api-client` generated `openapi-fetch`, `ui` primitives, and `testkit`/`test/journeys/` real-process proof.
- `tools/openapi-codegen/` — private TS5/OpenAPI generator, never runtime/public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Workspace

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- Root scripts own typecheck/build/boundaries/lint/clean and deterministic `contracts:*`/`api:*` generation/check.
- `api-client` uses runtime `openapi-fetch@0.17.0`; codegen alone has exact TS 5.9.3/OpenAPI Typescript 7.13.0. No application/runtime source imports the tools workspace.
- `testkit` contains temp-home containment, child cleanup, stable summaries, and fresh headless contexts; denied loopback is `UNMET`.
- `apps/control-plane` is the thin foreground Fastify composition façade. `auth`, `routes`, `ws-replay`, `compatibility`, and `lifecycle` keep bearer/browser policy, validated routes/errors, bounded injected replay, concrete legacy `/api/health`/`/api/meta` + static shell, and nonce-safe service/LaunchAgent lifecycle separate (`docs/architecture/control-plane.md`).

### `scripts/check-boundaries.mjs`

- Reads dependency metadata/imports including root JS/MJS, normalizing `@golem/*` subpaths before direction checks.
- Its nine fixtures cover metadata-only, compat-subpath, and root-level codegen MJS cases.

## Data flow and constraints

Hooks/shims write below `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. The control-plane shell exposes typed `/api/v1`, versioned `/ws`, and static compatibility only; it neither imports legacy dashboard state nor migrates runtime/tracker routes. Direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compat, storage, UI, harness, or tools.

- Nested `mcp/channel` postinstall/lock is the declared temporary GOL-29 legacy closure, not a second canonical lock.
- Never peer-bypass, import `tools/**` from production, or include workspace symlinks/TS5 in the root tarball. TS 7 uses `--stopBuildOnErrors`.

## Common tasks

| Task | Files | Verify with |
|---|---|---|
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, typecheck/build, boundaries, lint |
| Control plane | `apps/control-plane`, `packages/api-client`, J6 | Node 24 `api:generate`, `api:check`, J6, browser shell |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
