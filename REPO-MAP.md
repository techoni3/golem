# REPO-MAP.md
> Last verified: 2026-07-20 @ 2dd6557 — maintained via golem:docs-maintenance.

## Structure

- `apps/` — private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` — `contracts` owns wire schemas; `persistence` owns one SQLite writer; `testkit`/`test/journeys/` own serial real-process proof.
- `tools/openapi-codegen/` — isolated TS5/OpenAPI source generator, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products.
- `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are public/compatibility surfaces; `test/` has journey fixtures.

## Workspace and entrypoints

### Root `package.json`, `tsconfig*.json`, and `biome.json`

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while legacy JS stays unchecked. `typecheck`, `build`, boundaries, lint, clean, and `api:*` are the typed-scaffold contract.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns private TS 5.9.3/OpenAPI Typescript 7.13.0. `contracts:*` owns the deterministic v1 registry and one JSON-wire journey.
- `testkit` owns temp-home containment, child cleanup, stable summaries, and fresh-context browser fixtures; denied loopback is `UNMET`.
- `persistence` owns the private SQLite/Kysely owner, runtime/tracker connection policy, locks, immutable checked migrations, clone-verified dry-runs, backups, and leased runtime outbox; only its control-plane composition port can write.
- `packages/ui` owns semantic tokens/React Aria wrappers; `apps/dashboard/src/design-lab` is its isolated consumer.

### `scripts/check-boundaries.mjs`

- Reads dependency metadata/imports (including root JS/MJS), normalizing `@golem/*` subpaths before direction checks; its nine fixtures are regression proof, not a mock farm.

## Data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Typed direction is contracts → runtime/tracker → control plane → client → compatibility surfaces.

## Constraints

- `mcp/channel`'s nested postinstall/lock is the GOL-29 legacy exception, not a second canonical lock.
- Never peer-bypass, import `tools/**` from production, or ship workspace symlinks/TS5 in the root tarball.
- TS 7 uses `--stopBuildOnErrors`; Claude loads cached render bytes after sync/update/reload.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| Typed workspace | `apps/`, `packages/`, `tools/`, root configs | Node 24 `npm ci`, `typecheck`, `build`, boundaries, lint |
| SQLite persistence | `packages/persistence/`, `test/persistence/`, `docs/architecture/persistence.md` | Node 24 `test:persistence`, selected J3, fixtures, boundaries |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
