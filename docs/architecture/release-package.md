# Release package boundary

Golem publishes one root package. Private npm workspaces are build-time
ownership boundaries, not install-time packages.

## Build and runtime graph

```text
apps/* + packages/* + dashboard source
        │ TypeScript/Vite/esbuild (development only)
        ▼
dist/release/*.mjs + dashboard/dist/control-plane + golem-mcp.mjs
        │ positive npm files allowlist
        ▼
@laveesingh/golem tarball
        │ production dependencies
        ▼
Node 24 + better-sqlite3 12.11.1 + local GOLEM_HOME
```

`scripts/build-release-artifacts.mjs` bundles the typed CLI, canonical control
plane, managed Codex host, migration command, and C3 legacy dashboard fallback.
The root compatibility CLI prefers those artifacts and uses workspace outputs
only in a source checkout. Static dashboard bytes and substrate/render inputs
remain explicit assets.

The production package does not contain `apps/`, source TypeScript,
`tools/openapi-codegen`, TypeScript, `openapi-typescript`, Playwright, Biome,
Vite, esbuild, generated workspace symlinks, `mcp/channel`, or nested
`node_modules`. The MCP artifact includes its JavaScript closure. Native
`better-sqlite3` remains an exact external dependency so npm can select or
compile the correct platform ABI.

## Lifecycle

Postinstall is validation-only. It checks Node, artifact checksums, the exact
native dependency version, and an in-memory SQLite query. It never opens a
listener, starts LaunchAgent, writes Golem state, renders integrations,
migrates data, or installs another package.

Setup is explicit: render the desired targets, install the harness integration,
then start the dashboard or use the preview-hashed service controls in Settings.
Updates are npm-owned and followed by explicit render refresh. Rollback installs
the retained prior package version and force-restores its generated render;
canonical databases are preserved. Legacy-data migration and C4 cutover remain
separate exact-hash commands documented in `cutover-runbook.md`.

## Evidence

- `npm run verify:package` packs and cold-installs into disposable
  home/cache/prefix locations, inspects the allowlist and checkout-path absence,
  loads native SQLite with WAL/restart/integrity, starts/stops the packaged
  service, serves UI/API, initializes MCP, and renders every target.
- `npm run verify:render` proves the artifact/render drift and tamper contract.
- `npm run test:journey -- --scenario install-update-rollback` exercises
  migration/package pointer preservation and injected rollback.
- `npm run docs:check` keeps commands, versions, ownership, and generated
  boundaries aligned.

Air-gapped native installation is unsupported unless the correct prebuild or a
working cached compiler toolchain is already available.
