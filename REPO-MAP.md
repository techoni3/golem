# REPO-MAP.md
> Last verified: 2026-07-20 @ Wave 4 reconciliation — maintained via golem:docs-maintenance.

## Structure

- `apps/` are private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` are strictly directed: `contracts` owns schemas, `domain` pure policy, `compiler` deterministic manifests, `mcp-adapter` schema validation/API delegation, and `testkit`/journeys serial real-boundary proof.
- `tools/openapi-codegen/` is isolated TS5 source generation, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Workspace contract

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- `typecheck`, build, boundaries, lint, clean, and `api:*` are the typed-scaffold contract.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `contracts:*` owns deterministic v1 registry regeneration; `test:contracts` is its one JSON-wire journey.
- `domain` is the pure layered kernel; its compact J2 replay is `test:domain`/`domain-replay`.
- `testkit` owns temp-home/child cleanup, stable summaries, semantic comparison, and fresh headless fixtures; loopback denial is `UNMET`.
- `packages/ui` owns semantic token layers/React Aria; `apps/dashboard/src/design-lab` is its isolated consumer.

## Boundary and data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. Direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compatibility, storage, UI, harness, or tools. The rendered MCP validates schemas and calls its injected API client.

Canonical alias kinds and optional session resolution originate in contracts; domain returns unresolved evidence for review and never auto-links it. `scripts/check-boundaries.mjs` retains `@golem/*` subpaths and rejects MCP-to-domain imports; fixtures are regression proof.

## Constraints

- The nested `mcp/channel` postinstall/lock remains the current GOL-29 rendered closure; the relocatable artifact is a separately verified deferred-cutover candidate, not `.mcp.json`'s entrypoint.
- `docs/architecture/render-mcp-closure.md` owns the five-target compiler, packed-channel, and isolated-artifact J1 gate.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 uses build-mode `--stopBuildOnErrors`; Claude uses cached render bytes after substrate sync/update/reload.

## Common tasks

| Task | Files | Verify with |
|---|---|---|
| Typed workspace | `apps/`, `packages/`, `tools/` | Node 24 typecheck, build, boundaries, lint |
| Render/MCP closure | compiler, mcp adapter, J1 journey | Node 24 `npm run verify:render` |
| Domain policy | `packages/domain/`, `test/domain/replay.mjs` | Node 24 `test:domain`, J2 `domain-replay` |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
