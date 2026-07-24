# Development and generated-source contract

Use Node 24.18.x and npm 11.16.x. `npm ci` at the repository root is the only
supported dependency installation; do not add a workspace lockfile or use
`--force`/`--legacy-peer-deps`.

Root TypeScript is 7.0.2. The private `tools/openapi-codegen` workspace pins
TypeScript 5.9.3 and `openapi-typescript` 7.13.0 because that generator's peer
range is intentionally isolated. `npm run api:check` is the deterministic
boundary. None of that tool workspace ships; only generated runtime client
behavior and `openapi-fetch@0.17.0` cross the release boundary.

Ownership:

- Edit application and domain code under `apps/` and `packages/`.
- Edit canonical harness assets under `substrate/`.
- Never hand-edit `plugin/`, `dist/release/`, dashboard dist, generated
  OpenAPI/client output, or `$GOLEM_HOME/renders/`.
- Regenerate through the owning build/sync command and use `--check` in CI.
- Update `REPO-MAP.md` whenever an entry point, module boundary, invariant, or
  data flow changes.

Tests are journey-level. Use real processes, loopback services, SQLite,
temporary homes, and failure injection at a meaningful contract; avoid
mock-heavy utility fan-out and test-count goals. Browser work follows the
headless shared-profile policy. Packaging and release checks must never read or
mutate a contributor's live Golem home.

Before handoff, record exact commands, exits, decisive counts/logs, migration
and rollback impact, branch and commit, and residual risk.
