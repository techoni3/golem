# REPO-MAP.md
> Last verified: 2026-07-20 @ f9f67e6 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` — strict boundaries: `contracts` owns Zod v1 schemas; `domain` owns pure deterministic policy; `compiler` owns deterministic manifests; `mcp-adapter` validates then delegates via `api-client`; `testkit` and journeys own serial real-boundary proof.
- `tools/openapi-codegen/` — isolated TS5/OpenAPI source generator, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are public/compatibility surfaces; `test/` has journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- `typecheck`, `build`, boundaries, lint, clean, and `api:*` are the typed-scaffold contract; clean removes named outputs only.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `contracts:*` regenerates/checks the deterministic v1 registry; `test:contracts` is its single table-driven JSON-wire journey.
- `domain` is a pure layered kernel: `identity`/`lifecycle`/`ordering` protect facts, `capabilities`/`readiness` resolve boundary state, `projections`/`explain` expose decisions, and `index` is the thin public seam. Its compact J2 replay is `test:domain`/`domain-replay` (see `docs/architecture/domain-kernel.md`).
- `testkit` owns temp-home containment, child termination, stable summaries, semantic comparison, and fresh-context headless fixtures; loopback denial is `UNMET` (see `docs/architecture/testing.md`).
- `packages/ui` owns ordered semantic token layers/React Aria wrappers; `apps/dashboard/src/design-lab` is its isolated consumer (`test:ui-primitives`).

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
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, `typecheck`, `build`, boundaries, lint |
| Render/MCP closure | compiler, mcp adapter, J1 journey | Node 24 `npm run verify:render` |
| Domain policy | `packages/domain/`, `test/domain/replay.mjs` | Node 24 `npm run test:domain`, `npm run test:journey -- --scenario domain-replay` |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
