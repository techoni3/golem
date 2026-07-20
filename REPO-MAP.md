# REPO-MAP.md
> Last verified: 2026-07-20 @ 731a2b3 — maintained via golem:docs-maintenance.

## Structure

- `apps/` are private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` are strictly directed: `contracts` owns Zod v1 schemas, `domain` pure policy, and `testkit`/`test/journeys` serial real-process proof.
- `tools/openapi-codegen/` is isolated TS5 source generation, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Workspace contract

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- `typecheck`, build, boundaries, lint, clean, and `api:*` are the typed-scaffold contract; clean removes named outputs only.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `contracts:*` owns deterministic v1 registry regeneration; `test:contracts` is its one JSON-wire journey.
- `domain` is the pure layered kernel; its compact J2 replay is `test:domain`/`domain-replay` (see `docs/architecture/domain-kernel.md`).
- `testkit` owns temp-home/child cleanup, stable summaries, semantic comparison, and fresh headless fixtures; loopback denial is `UNMET`.
- `packages/ui` owns semantic token layers/React Aria; `apps/dashboard/src/design-lab` is its isolated consumer.

## Boundary and data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Typed direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compat, storage, UI, harness, or tools.

Canonical alias kinds and optional session resolution originate in contracts; domain returns unresolved evidence for review and never auto-links it. `scripts/check-boundaries.mjs` normalizes `@golem/*` subpaths; its nine direction fixtures are the regression proof.

## Constraints

- The nested `mcp/channel` postinstall/lock is a temporary GOL-29 legacy closure, not a second canonical lock.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 uses build-mode `--stopBuildOnErrors`, not `--stopOnBuildErrors`; Claude uses cached render bytes after substrate sync/update/reload.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| Typed workspace | `apps/`, `packages/`, `tools/` | Node 24 `npm ci`, `typecheck`, `build`, boundaries, lint |
| Domain policy | `packages/domain/`, `test/domain/replay.mjs` | Node 24 `test:domain`, J2 `domain-replay` |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
