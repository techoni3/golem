# REPO-MAP.md
> Last verified: 2026-07-24 @ GOL-59 packaged release boundary — maintained via golem:docs-maintenance.

## Structure

- `apps/cli/src/` owns typed grammar and UX; writes require `--apply`; completions/aliases never edit shell RC files.
- `packages/` contains domain, client, testkit, UI, and adapters; transports consume canonical ports without storage.
- `apps/control-plane/` composes hosts; `dashboard/web` is legacy. API/client/MCP are storage-free; `substrate/` renders plugin assets.
- `scripts/build-release-artifacts.mjs` folds private workspace code into `dist/release/`; the public tarball ships those compiled artifacts, static dashboard bytes, runtime helpers, substrate, shims, and licenses—never workspace source or symlinks.

## Invariants and flow

- Canonical flow is contracts → domain/runtime/tracker → control plane → generated client; compat/storage/UI/harness do not import inward.
- One npm11 lock; `packages/persistence` is the sole SQLite writer, recovery owner, and migration owner.
- The contributor graph uses root TypeScript 7.0.2. Only the private `tools/openapi-codegen` workspace owns TypeScript 5.9.3 plus `openapi-typescript` 7.13.0; neither compiler nor the generator ships. Production keeps `openapi-fetch` and exact `better-sqlite3` 12.11.1.
- C4 authority is one atomic `$GOLEM_HOME/control-plane/authority.json` pointer. `packages/persistence/src/authority.ts` selects `canonical/runtime.db` only at C4 while root `tracker.db` remains its GOL-20 authority; `packages/compat/src/cutover/` owns exact-hash preflight, checkpoint, resume, soak, and audited non-lossy rollback. Legacy JSON/channel/dashboard writers share `lib/legacy-writer-guard.js`. See `docs/architecture/cutover-runbook.md`.
- Tracker owns durable delivery and typed work-item/phase/comment/link/stream services; exceptional close is server-composed.
- `CommandGateway` atomically writes tracker/management mutations, GOL-79 receipts, invalidations, settlement, and direct-core effects. Replays are inert; changed keys return `409`; semantic changes publish once; scope filtering precedes WS; HTTP revisions are truth.
- `TicketDispatchService` is the browser/bearer/MCP delivery seam. The current assignee must resolve fail-closed to an eligible active generation; GOL-79 queues `tracker_envelopes` as `ready`/`pull_only`/`next_turn`. Its read side joins project-scoped receipts, verified tickets, and canonical envelopes into safe dispatch operations; malformed or missing queue facts are omitted, and settlement never leaks targeting/claim/ack data. Terminal/ineligible writes create no envelope; stale CAS replays. Historical/runtime fields never select; only server-authenticated MCP exposes legacy alias/content, and durable binding—not credential spelling—defines provenance.
- Launcher owns fail-closed writes and immutable LaunchPlan facts; CLI consumes them for picker/presets.
- Control plane owns REST/WS. Browser work uses generated paths, same-origin cookie reads/WS, CSRF commands, and a metadata-only synchronizer that replaces snapshots and refetches every invalidation; it accepts no browser authority or domain merge. Its allowlist now covers bounded ticket prose/labels/tree/streams/comments/links/assets plus redacted roles/gates/ideas. Legal phase candidates and all mutations remain server-composed; raw assignees, runtime identities, paths, payloads, and credentials never enter the projection. GOL-80 scopes opaque frames before construction; foreign detail is absent.
- Browser settings flow is `packages/contracts/src/browser-settings.ts` → `apps/control-plane/src/browser-settings-{services,routes}.ts` → generated OpenAPI/client → `apps/dashboard/src/routes/settings/`. The server composes service, render, capability, provider, preset, migration, and audit truth; all mutations require browser CSRF plus exact preview hashes. Durable idempotency receipts live under `$GOLEM_HOME/control-plane/` and contain only hashed keys and redacted result facts.
- `apps/dashboard/src/routes/{tracker,specs,review,settings}/` owns the typed browser UI. It renders only bounded public projections; supports ticket collaboration, project-role assignment, gates, ideas, ticket-scoped asset reads, and preview-confirmed settings controls; retains one-shot drafts across conflicts/failures; and treats delivery settlement separately from dispatch disposition.
- `test/browser/work-control-plane.mjs` is the real browser-control journey lane: a compiled control plane, public generated client, built dashboard, ephemeral headless Chrome, typed board/settings HTTP, canonical invalidations, ticket collaboration/management/asset actions, settings preview/apply/rollback checks, dispatch/delivery callbacks, restart resync, responsive checks, and failure-only sanitized artifacts. `test/settings/settings-services.test.mjs` covers durable service/render/provider/preset/migration behavior without a browser; the named journey scenarios expose provider/preset parity and migration dry-run/rollback evidence.
- Project identity is canonical Git paths; sessions have immutable generations, scoped aliases, provenance, terminal monotonicity, and deterministic effects.
- Projections read canonical rows only; diagnostics and WS invalidations are redacted/bounded.
- Endpoint claims are generation/route scoped: fences gate heartbeat, readiness, capability, delivery, and release; registration alone never qualifies delivery.
- Managed Codex is OpenAI/GPT-only; serialized consumption gates delivery readiness. Pi is pull/next-turn only; migrations audit an exact plan hash under a home lock.

## Checks and gotchas

- Tests use disposable homes; never mutate user state, shared ports, Docker, or renders. Loopback denial is `UNMET`.
- `packages/mcp-adapter/dist/golem-mcp.mjs` is the C4 render entrypoint. It bundles its SDK/client closure, so npm postinstall only validates checksums/native load and never performs a nested install or starts a service. `mcp/channel` remains source-checkout C3 evidence but is absent from the public package/render. Do not hand-edit renders or bypass boundaries.
- Node24 gates: build/typecheck, boundaries, named journeys, render, and `git diff --check`.
