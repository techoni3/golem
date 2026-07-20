# REPO-MAP.md
> Last verified: 2026-07-20 @ 4fdae77 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` — strict boundaries: `contracts` owns Zod v1 schemas; `testkit` and `test/journeys/` own serial real-process proof.
- `tools/openapi-codegen/` — isolated TS5/OpenAPI source generator, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are public/compatibility surfaces; `test/` has journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- `typecheck`, `build`, boundaries, lint, clean, and `api:*` are the typed-scaffold contract; clean removes named outputs only.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `contracts:*` regenerates/checks the deterministic v1 registry; `test:contracts` is its single table-driven JSON-wire journey.
- `testkit` owns temp-home containment, child termination, stable summaries, semantic comparison, and fresh-context headless fixtures; loopback denial is `UNMET` (see `docs/architecture/testing.md`).
- `packages/ui` owns ordered semantic token layers/React Aria wrappers; `apps/dashboard/src/design-lab` is its isolated consumer (`test:ui-primitives`).

### `scripts/check-boundaries.mjs`

- Reads dependency metadata/imports (including root JS/MJS), normalizing `@golem/*` subpaths to declared roots before direction checks.
- Its nine committed direction fixtures include metadata-only, compat-subpath, and root-level codegen MJS cases; they are the regression proof, not mock-heavy unit fan-out.

## Data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Typed direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compat, storage, UI, harness, or tools.

## Constraints

- The nested `mcp/channel` postinstall/lock is a declared temporary legacy closure for GOL-29, not a second canonical workspace lock.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 accepts build-mode `--stopBuildOnErrors`, not `--stopOnBuildErrors`.
- Claude uses cached render bytes; after substrate edits sync, update, and `/reload-plugins`.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, `typecheck`, `build`, boundaries, lint |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
