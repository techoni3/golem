# REPO-MAP.md
> Last verified: 2026-07-20 @ Wave 5 GOL-34 durable runtime ingress — maintained via golem:docs-maintenance.

## Structure

- `apps/` are private TypeScript seams; legacy entrypoints remain authoritative until vertical-slice cutover.
- `packages/` are strictly directed: `contracts` owns schemas, `domain` pure policy, `persistence` the single SQLite writer, `runtime` durable inbox/materialization/outbox orchestration, `launcher` redacted configuration/capability plans, `compiler` deterministic manifests, `mcp-adapter` schema validation/API delegation, `api-client` generated HTTP types, and `testkit`/journeys serial real-boundary proof.
- `tools/openapi-codegen/` is isolated TS5 source generation, never runtime or public packaging.
- `substrate/` is source; `plugin/` and `dashboard/dist/` are generated products. `cli/`, `lib/`, `dashboard/server/`, `mcp/channel/`, and `shims/` are compatibility surfaces.

## Workspace contract

- One npm 11 lock owns `apps/`, `packages/`, and `tools/`; applications use TS 7 while untouched JS stays unchecked.
- Root scripts own typecheck/build/boundaries/lint/clean and deterministic `contracts:*`/`api:*` generation and checks.
- `api-client` owns runtime `openapi-fetch@0.17.0`; codegen owns exact TS 5.9.3/OpenAPI Typescript 7.13.0 without `npx`.
- `domain` is the pure layered kernel; its compact J2 replay is `test:domain`/`domain-replay`.
- `persistence` owns private SQLite/Kysely, canonical node/edge, alias/harness/capability/lifecycle schemas, checked migrations, recovery, backup, injected clock, and bounded outbox; writer construction stays internal to control-plane.
- `runtime` makes producers filesystem-only: it fsyncs one no-clobber pending envelope per event, the single service moves it through processing/archive or quarantine, and atomically records canonical facts, diagnostics/watermarks, and the persisted outbox via the narrow persistence capability.
- `launcher` rejects conflicting preset overrides and owns redacted JSONC plus fail-closed capability plans; backup/temp/commit/rollback is save-only.
- `apps/control-plane` is the thin foreground Fastify composition façade. Typed `/api/v1/ws` accepts bearer CLI/MCP callers without Origin; bounded HttpOnly browser sessions require exact Origin/Host/protocol/port; headerless legacy `/ws` uses only an injected compatibility source.
- `testkit` owns temp-home/child cleanup, stable summaries, semantic comparison, and fresh headless fixtures; loopback denial is `UNMET`.
- `packages/ui` owns semantic tokens/React Aria; `apps/dashboard/src/design-lab` is its isolated consumer.

## Boundary and data flow

Hooks/shims write beneath `GOLEM_HOME`; dashboard REST/WS and tracker phase remain authoritative. The control-plane shell exposes typed `/api/v1` and `/api/v1/ws` while retaining bounded static/headerless legacy compatibility; authenticated producers can POST a GOL-26 runtime signal to `/api/v1/runtime/events`, which only spools it. Direction is contracts → domain/runtime/tracker → control plane → client → CLI/MCP/dashboard; canonical packages never import compatibility, storage, UI, harness, or tools. The rendered MCP validates schemas and calls its injected API client.

Canonical alias kinds and optional session resolution originate in contracts; domain returns unresolved evidence for review and never auto-links it. `scripts/check-boundaries.mjs` retains raw `@golem/*` subpaths, forbids non-control-plane writer construction, and rejects MCP-to-domain imports; fixtures are regression proof.

## Constraints

- The nested `mcp/channel` postinstall/lock remains the current GOL-29 rendered closure; the relocatable artifact is a separately verified deferred-cutover candidate, not `.mcp.json`'s entrypoint.
- `docs/architecture/render-mcp-closure.md` owns the five-target compiler, packed-channel, and isolated-artifact J1 gate.
- Never peer-bypass, import `tools/**` from production code, or include workspace symlinks/TS5 in the root tarball.
- TS 7 uses build-mode `--stopBuildOnErrors`; Claude uses cached render bytes after substrate sync/update/reload.

## Common tasks

| Task | Files | Verify with |
|---|---|---|
| Typed workspace | `apps/`, `packages/`, `tools/` | Node 24 `npm ci`, typecheck/build, boundaries, lint |
| Render/MCP closure | compiler, mcp adapter, J1 journey | Node 24 `npm run verify:render` |
| Domain policy | `packages/domain/`, `test/domain/replay.mjs` | Node 24 `test:domain`, J2 `domain-replay` |
| SQLite persistence | `packages/persistence/`, `test/persistence/`, `docs/architecture/persistence.md` | Node 24 `test:persistence`, selected J3, fixtures, boundaries |
| Durable runtime engine | `packages/runtime/`, `test/runtime/`, `docs/architecture/runtime-ingress.md` | Node 24 `test:runtime-engine`, J3 `materializer-crash-matrix`, J1 `dashboard-down-inbox-replay` |
| Control plane | `apps/control-plane`, `packages/api-client`, J6 | Node 24 `api:generate`, `api:check`, J6, browser shell |
| Launcher resolution | `packages/launcher/`, `test/launcher/replay.mjs` | Node 24 J7 `launcher-resolution-matrix` |
| Legacy runtime | `cli/`, `dashboard/`, `mcp/channel/`, `shims/` | temp-home legacy baseline |
