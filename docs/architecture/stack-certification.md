# Stack certification probe

`npm run verify:stack` is an isolated adoption-certification probe. It is not an
application migration, a dashboard build, or a replacement for the existing
release journeys.

## Contract

The probe refuses to certify unless the process is exactly within the accepted
target pair:

- Node `>=24.18.0 <25`
- npm `11.16.0`

The fixture pins the proposed Wave 1 dependencies: application TypeScript 7.0.2
plus the 6.0.3 fallback alias, better-sqlite3 12.11.1, Fastify 5 / Zod 4 /
OpenAPI, Fastify WebSocket, React 19 / Vite 8, MCP SDK v1, esbuild, and Biome
2.5.4. Its private `tools/openapi-codegen` workspace owns the generator-only
toolchain: exact TypeScript 5.9.3 and exact openapi-typescript 7.13.0. The
application root deliberately does not own openapi-typescript; it consumes the
codegen output through the root TypeScript 7 compiler.

Dependencies are installed only after the version gate into a fresh temporary
directory with ordinary lifecycle scripts enabled (no `--ignore-scripts`, peer
bypass, or committed fixture lockfile). npm 11 uses its nested install strategy
so the private tool's exact compiler and generator remain workspace-local. The
probe supplies a temporary `HOME`, `GOLEM_HOME`, XDG config/cache, npm user
config, and npm cache; it neither reads nor mutates user runtime state. Install
resolution has a 180,000 ms total deadline; every other spawned certification
command has a 60,000 ms deadline. On expiry the detached process group receives
`SIGTERM`, then `SIGKILL` after 5,000 ms even if its leader exits first; the
resulting row details retain timing, signal, and captured command output.
SIGINT/SIGTERM follows the same process-group and temporary-root cleanup
discipline.

`test/stack-certification/result-schema.json` is the durable result shape. It
contains the host OS/architecture and tool versions, a PASS/FAIL row for every
adoption boundary, and both Darwin architecture result rows. A non-current
architecture is `UNMET`, never implied PASS.

## Boundaries exercised on an eligible host

The fixture has no dependency on the repository root `node_modules`:

1. topology assertions prove root TypeScript 7.0.2, workspace-local TypeScript
   5.9.3 and openapi-typescript 7.13.0, and a clean npm peer tree; a strict
   project-reference build then runs with TypeScript 7 while the installed
   TypeScript 6 alias is separately recorded as the fallback result;
2. a real file-backed SQLite database enables WAL and foreign keys, commits and
   rolls back transactions, closes/reopens, then checks foreign keys and
   integrity;
3. one Zod source schema drives a Fastify endpoint and OpenAPI document; the
   private codegen workspace generates its client types and root TypeScript 7
   compiles a real `openapi-fetch` consumer before the real client request,
   400 invalid-input handling, and 500 response validation handling;
4. a loopback WebSocket sends a snapshot and verifies a resume exchange;
5. Vite builds a React asset which is served and fetched through Fastify static;
6. esbuild produces MCP server/client bundles in a sibling directory with no
   parent or render `node_modules`; each ESM bundle receives a
   `createRequire(import.meta.url)` bridge for bundled CommonJS-only SDK
   transitive code. A rendered client launches its rendered server with
   `NODE_PATH` cleared and performs initialize/list-tools/call-tool;
7. Biome checks the fixture and compiled `node:test` imports the generated ESM
   workspace package.

Run the machine-readable form with:

```sh
npm run verify:stack -- --json
```

The normal form prints the same rows for a human. `--keep` retains the otherwise
deleted temporary fixture only for local forensic inspection.

## Current evidence record

At GOL-23 implementation time the checked host is Darwin/arm64 with Node
`v26.5.0` and npm `12.0.1`. Those versions are intentionally ineligible. The
probe exits `1`, emits `overall: "FAIL"`, and records all nine adoption rows as
version-gated failures. No fixture dependency is installed and no adoption row
is claimed PASS on that host.

Darwin/x64 remains `UNMET` until it is executed under the exact Node/npm pair;
that is the C4 cross-architecture release gate. Network or native dependency
installation failures on an eligible host are likewise recorded as FAIL evidence
and keep the process nonzero.

## Rollback

The probe creates no persistent runtime data. Reverting its root package scripts
and removing `test/stack-certification/` plus
`test/fixtures/stack-certification/` removes the feature. No database, package,
or global toolchain rollback is required.
