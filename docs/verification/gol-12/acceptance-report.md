# GOL-12 final acceptance report

Overall: **PASS** · zero gaps: **yes**

## Release candidate

- Package: `@laveesingh/golem@5.1.1`
- Tarball: `laveesingh-golem-5.1.1.tgz` (338 files)
- SHA-256: `a452a612bc09f6b0c082bd51e968563a09dbf1c8903b85b2ffd2d444fc835cf4`
- Runtime: v24.18.0, npm 11.16.0, ABI 137, darwin/arm64
- Native: better-sqlite3 12.11.1, SQLite 3.53.2; WAL/restart/integrity PASS
- Dependency gate: TypeScript 7.0.2; isolated codegen TypeScript 5.9.3 + openapi-typescript 7.13.0; openapi-fetch 0.17.0

Postinstall remained stopped. The installed CLI, completions, all five render targets, SQLite, and API-client runtime executed with the checkout hidden; source workspaces, TypeScript compilers, codegen, Playwright, and nested MCP dependencies were absent.

## J1–J8 matrices

| Matrix | Status | Decisive real-boundary scenarios |
|---|---|---|
| J1 | PASS | `install-update-rollback`, `dashboard-down-inbox-replay` |
| J2 | PASS | `cross-harness-session-lifecycle`, `project-identity-git-worktree-relocation` |
| J3 | PASS | `materializer-crash-matrix`, `codex-managed-delivery-crash-matrix` |
| J4 | PASS | `claude-lifecycle-channel-recovery`, `tracker-http-mcp-parity`, `delivery-api-fence-recheck` |
| J5 | PASS | `compact-launcher-matrix`, `launcher-launchability-delivery-split`, `opencode-provider-coexistence` |
| J6 | PASS | `projection-ws-restart-resync`, `committed-outbox-all-write-paths`, `roles-gates-ideas-controls` |
| J7 | PASS | `canonical-cutover-crash-rollback`, `migration-apply-crash-rollback` |
| J8 | PASS | `dashboard-runtime-lifecycle` |

## Browser and compatibility gates

- Browser acceptance: **PASS** — accessibility-responsive-themes pass, dashboard-state-matrix pass, work-control-plane pass.
- Legacy rollback baseline: **PASS** — 3 real-boundary scenarios.

## GOL-12 behavior mapping

| Requirement | Status | Evidence |
|---|---|---|
| GOL12-B01 | PASS | ENTRY, J6 — A strict TypeScript-first architecture defines shared domain contracts across adapters, runtime, persistence, control plane, CLI, and web UI. |
| GOL12-B02 | PASS | J2, J4, J5 — Harness adapters translate Claude Code, Codex, OpenCode, Pi, and supported backend/model capabilities into versioned canonical contracts. |
| GOL12-B03 | PASS | J2, J3 — One durable control-plane model owns identity, generations, endpoint fencing, lifecycle, activity semantics, readiness, and diagnostics. |
| GOL12-B04 | PASS | J2, J3, J4 — Registration, lifecycle changes, crash recovery, and projections behave deterministically across supported harnesses. |
| GOL12-B05 | PASS | J5 — The compact launcher has deterministic precedence, presets, capability validation, concise output, diagnostics, and non-recursive invocation. |
| GOL12-B06 | PASS | J4, J6 — Dashboard, sessions, tracker, controls, CLI, and diagnostics consume typed APIs and materialized views. |
| GOL12-B07 | PASS | J8, BROWSER — The dashboard has an accessible design system, bounded responsive layouts, and light/dark/system themes. |
| GOL12-B08 | PASS | J7, LEGACY — Existing data and integrations have dry-run migration, compatibility, observable cutover, and nondestructive rollback. |
| GOL12-B09 | PASS | J1, J7, LEGACY — Delivery is staged behind parity and migration gates and each wave remains runnable. |
| GOL12-B10 | PASS | J1, J2, J3, J4, J5, J6, J7, J8 — Verification uses real SQLite, processes, services, concurrency, reordering, duplicate delivery, crashes, restart, migration, launch UX, and UI states. |
| GOL12-B11 | PASS | ENTRY — Repository structure, decisions, contributor workflow, generated boundaries, and invariants are documented. |
| GOL12-B12 | PASS | ENTRY — Deep design documents, ADRs, component/data-flow, migration, and dependency-ordered implementation planning exist. |
| GOL12-B13 | PASS | TRACKER — Builder briefs retain parent, ADR, predecessor, acceptance, workspace, and non-goal context. |
| GOL12-B14 | PASS | J1, J2, J3, J4, J5, J6, J7, J8, BROWSER, LEGACY — The replacement demonstrates retained parity, GOL-6 lifecycle consistency, and GOL-11 launcher truth. |

## Retained parity mapping

| Capability | Status | Matrix | Disposition |
|---|---|---|---|
| dashboard-lifecycle | PASS | J6 | retained |
| managed-codex | PASS | J4 | retained |
| ordinary-codex | PASS | J4 | retained |
| claude-plugin-render | PASS | J1 | retained |
| claude-channel | PASS | J4 | retained |
| opencode-bridge | PASS | J4 | retained |
| pi-next-turn | PASS | J4 | retained |
| project-discovery | PASS | J2 | retained |
| session-facts | PASS | J2 | retained |
| journal-and-spool | PASS | J1 | retained |
| tracker | PASS | J4 | retained |
| dispatch-and-envelopes | PASS | J4 | retained |
| bus-and-passive-deltas | PASS | J3 | retained |
| roles-gates-ideas-diagnostics | PASS | J6 | retained |
| launcher-and-compatibility-aliases | PASS | J5 | compatibility |

Deliberate retirements retain explicit migration reasons:

- `removed-v3-cli` (retire): install, cleanup, reinstall, session, project, dispatch, and ack are absent current v3 commands.
- `legacy-registry-authority` (compatibility-only): JSON registries remain import/export inputs until C4 and must not become canonical authority.
- `old-agent-ws` (retire): agents-update, tickets-update, agent-detail, and orchestrator-update are removed v3 projection messages.

## Required commands

- `npm ci`
- `npm run build && npm run check`
- `npm run verify:package && npm run verify:render`
- `npm run test:acceptance -- --matrix J1,J2,J3,J4,J5,J6,J7,J8 --artifact packed`
- `npm run test:browser -- --project acceptance`
- `npm run test:legacy-baseline`
- `npm run parity:report -- --require-zero-gaps`

## Residual nonblocking risks

- `air-gapped-native`: Unsupported unless the correct native prebuild or cached compiler toolchain is present.
- `external-credential-qualification`: No credentialed capability is fabricated; absent binaries, models, daemons, or consumption evidence remain unavailable or pull-only/not-ready before spawn.
- `x64-host`: The same candidate has real x64 Node/addon/SQLite evidence under Rosetta; an independent physical x64 runner remains release-infrastructure hardening.
