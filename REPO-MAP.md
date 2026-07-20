# REPO-MAP.md
> Last verified: 2026-07-20 @ f9f67e6 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` — `contracts` owns Zod v1 schemas; `compiler` owns deterministic manifests; `mcp-adapter` validates then delegates via `api-client`; `testkit`/journeys own real-boundary proof.
- `tools/openapi-codegen/` — isolated TS5/OpenAPI source generator, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are public/compatibility surfaces; `test/` has journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; TS 7 apps leave legacy JS unchecked.
- `typecheck`, build, boundaries, lint, clean, and `api:*` define the typed scaffold.
- `api-client` owns `openapi-fetch@0.17.0`; codegen owns TS 5.9.3/OpenAPI Typescript 7.13.0.
- `contracts:*` checks a deterministic v1 registry; its JSON-wire journey is table-driven.
- `testkit` owns containment, termination, stable summaries, semantic comparison, and headless fixtures; loopback denial is `UNMET`.
- `packages/ui` owns semantic token layers/React Aria wrappers; dashboard design-lab is its isolated consumer.

### `scripts/check-boundaries.mjs`

- Reads dependency metadata/imports (including root JS/MJS), normalizing `@golem/*` subpaths to declared roots before direction checks.
- Ten direction fixtures cover metadata, compat subpaths, codegen MJS, and MCP-to-domain imports; they replace mock fan-out.

## Data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase are authoritative. Direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard. The rendered MCP only validates schemas and calls its injected API client.

## Constraints

- The nested `mcp/channel` postinstall/lock remains the current rendered closure for GOL-29; the relocatable artifact is a separately verified deferred-cutover candidate, not `.mcp.json`'s entrypoint.
- `docs/architecture/render-mcp-closure.md` owns the five-target compiler, packed-channel, and isolated-artifact J1 gate.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 accepts build-mode `--stopBuildOnErrors`, not `--stopOnBuildErrors`.
- Claude uses cached render bytes; after substrate edits sync, update, and `/reload-plugins`.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| Typed workspace | `apps/`, `packages/`, `tools/` | Node 24 typecheck, build, boundaries, lint |
| Render/MCP closure | compiler, mcp adapter, J1 journey | Node 24 `npm run verify:render` |
| Legacy runtime | `cli/`, dashboard, channel, shims | temp-home baseline |
