# REPO-MAP.md
> Last verified: 2026-07-20 @ 8a947fd — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript composition seams for future control-plane, CLI, and Vite dashboard; legacy entrypoints remain authoritative until their vertical slices land.
- `packages/` — strict private contracts, domain, persistence, runtime, tracker, adapters, launcher, client, MCP, UI, compat, compiler, and testkit boundaries.
- `tools/openapi-codegen/` — isolated TS 5.9.3/OpenAPI generation tool. It emits source only and never enters runtime or public packaging.
- `substrate/` is plugin source; `plugin/` is generated and never hand-edited. `dashboard/web/` produces generated `dashboard/dist/`.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are current public/compatibility surfaces; `test/` contains journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 root lock owns `apps/`, `packages/`, and `tools/`. Application references use pinned TS 7; untouched JS stays `allowJs` with `checkJs:false`.
- `typecheck`, `build`, `check:boundaries`, `lint`, `clean`, and `api:*` are the typed-scaffold contract. `clean` removes only named workspace outputs.
- `packages/api-client` owns runtime `openapi-fetch@0.17.0`. The codegen workspace owns exact `typescript@5.9.3` and `openapi-typescript@7.13.0`; root commands delegate without `npx`.

### `scripts/check-boundaries.mjs`

- Reads manifests and source imports, then rejects domain→persistence/Fastify/React/adapter, adapter→database, client→repository, canonical→compat, and tool/application edges.
- Its committed rejection-fixture matrix is the regression proof; do not replace it with mock-heavy unit fan-out.

## Data flow

Current hooks/shims write registries beneath `GOLEM_HOME`; `dashboard/server/index.js` owns REST/WS while `tracker-db.js`/`phase-machine.js` keep phase authoritative. Typed direction: contracts → domain/runtime/tracker → control plane → API client → CLI/MCP/dashboard. Compat may consume canonical services; canonical packages never import compat, storage, UI, harness, or tool code.

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
| Plugin source | `substrate/`, `plugin/` | sync check |
