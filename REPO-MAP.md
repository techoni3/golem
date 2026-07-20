# REPO-MAP.md
> Last verified: 2026-07-20 @ dd78276 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints lead through cutover.
- `packages/` — `contracts` owns schemas; `launcher` owns redacted JSONC, fail-closed capability plans, and atomic writes; `testkit`/journeys own proof.
- `tools/openapi-codegen/` — isolated TS5/OpenAPI source generator, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are public/compatibility surfaces; `test/` has journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; TS 7 apps leave JS unchecked.
- Typed scaffold: `typecheck`/build/boundaries/lint/clean/`api:*`; clean removes named outputs.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `contracts:*` checks deterministic v1 registry; `test:contracts` is one table JSON-wire journey.
- `launcher` rejects conflicting preset overrides; backup/temp/commit/rollback is save-only (see `docs/architecture/launcher-resolution.md`).
- `testkit` owns temp homes, child cleanup, stable semantic summaries, and headless fixtures; loopback is `UNMET` (see `docs/architecture/testing.md`).
- `packages/ui` owns ordered semantic tokens/React Aria; dashboard design-lab is its isolated consumer (`test:ui-primitives`).

### `scripts/check-boundaries.mjs`

- Normalizes dependency metadata/imports, including root JS/MJS and `@golem/*` subpaths, before direction checks.
- Nine committed fixtures cover metadata-only, compat-subpath, and root-codegen MJS cases; they are regression proof, not mock fan-out.

## Data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase are authoritative. Typed direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compat, storage, UI, harness, or tools.

## Constraints

- The nested `mcp/channel` postinstall/lock is a declared temporary legacy closure for GOL-29, not a second canonical workspace lock.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 accepts build-mode `--stopBuildOnErrors`, not `--stopOnBuildErrors`.
- Claude uses cached render bytes; after substrate edits sync, update, and `/reload-plugins`.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, `typecheck`, `build`, boundaries, lint |
| Launcher resolution | `packages/launcher/`, `test/launcher/replay.mjs` | J7 |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
