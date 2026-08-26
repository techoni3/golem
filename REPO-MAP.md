# REPO-MAP.md
> Last verified: 2026-08-06 @ GOL-135 working tree — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; `plugin/` is its generated CC render, never hand-edited. Roles
  have one source: `instructions/AGENTS.md`; cards and skills point to it.
- `.claude/skills/` — repo-only doctrine for instructions, roles, and skills.
- `cli/` `lib/` — entry point; runtime, role, compiler, managed-harness helpers. `golem pi`
  syncs the render, and appends Golem's explicit bridge extension while
  Pi keeps its normal profile, authentication, providers, models, extensions, and sessions.
- `dashboard/server/` — Fastify API and tracker owner. `dashboard/web/` → `dashboard/dist/`.
- `mcp/channel/` — channel server. `shims/{opencode,codex}/` — harness events onto hooks.
- `test/` — journey tests.

## Key modules
### `dashboard/server/` — `index.js`, `tracker-db.js`, `comment-dispatch.js`
- Agents use HTTP/MCP, never direct DB writes. `state`
  (`todo|in_progress|blocked|review|done|archived`) is the only ticket lifecycle for every kind —
  phases were removed in GOL-150 (the `phase` column is dormant history).
- Three doc types: `spec` (living design doc), `task` (unit of work, the default), `doc`
  (supporting page). GOL-151 remapped the old five (work-item/fix→task, decision/question→doc) and
  retired streams and dependency waves — `parent_id` is the only grouping, sequencing is prose in
  the spec body, and `stream_id`/`wave` are dormant columns.
- Dispatch is durable-first, rolled back to `undispatched` on an undelivered push. Active
  `session_notify` envelopes wake exact session ids; the event ledger is audit-only.
- Ticket rows and retries share one typed lifecycle and total per-session order. Acceptance retains
  exact queue/comment owners; only an authenticated terminal callback settles them.
### `lib/session-role.js`
- `BUILTIN_ROLES` is the hardcoded role source; migrations map a retired name forward.
### `lib/golem-client.js`, `lib/golem-tool-contracts.js`, `lib/golem-tool-runtime.js`
- Harness-neutral native-tool seam: one immutable schema source, one structured-error REST client,
  and trusted adapter-context execution/registration. MCP advertises these contracts directly;
  CC, Codex, and Pi package the same contracts. Pi translates only its native execute/result shape.
- Passive subscription wrappers are explicitly retired; active notification and tracker-backed
  dispatch are the current shared coordination surface.
### `lib/pi-native-adapter.js`, `lib/pi-compatibility.js`, `shims/pi/golem.ts`
- Pi binds the shared typed-worker endpoint to native `sendUserMessage`, with a synchronous
  starting reservation, correlated agent acceptance/settlement, control abort/halt, durable replay,
  endpoint leases, terminal facts, and central journaling. The old Pi inbox is migration-read-only.
- The Pi render also registers shared tools, injects Golem-owned authority plus the current
  builder/explorer/reviewer card at safe turn boundaries, exposes progressive skills, and executes
  the shipped bounded L4 hook. The launcher and dashboard use one pinned compatibility
  contract. Its Tier-A worker capability is verified by the installed-artifact release matrix.
### `lib/typed-worker-endpoint.js`, `lib/typed-delivery-tombstones.js`
- Shared protocol validates authenticated, versioned envelopes; rich supervisor history is never the
  replay ledger. Terminal tracker retirement prunes lifecycle detail only after a non-evicting
  compact rejection is durable; wire expiry is renewable. Retries reserve before transport,
  arbitrate with ticket rows, and typed capability survives lease rebind; legacy
  Pi requires an explicit Tier-B fact.
- Replay tombstones use Node 22's built-in SQLite so isolated native-adapter renders do not depend on
  an architecture-specific addon.
### `substrate/hooks/tracker-context.sh`
- Builds the SessionStart payload — role card, LSP, recently-closed pointers, recent commits. All
  derived; fail-open per field; per-field and aggregate caps. It intentionally carries no live
  roster; `sessions_dispatchable` is the just-in-time source before a handoff. Also via
  `project_context`.
- Its node block sits inside a command substitution: a bare dollar-paren pair or a lone apostrophe
  in a JS comment breaks it, with an EOF error pointing at the last line.

## Data flow
Hooks/shims write `~/.golem/` registries; dashboard owns routes; native rows mean presence,
dispatchable rows mean readiness. Typed-worker leases keep quiet Pi/Codex workers live without
forging activity timestamps, and dashboard controls enter the same durable envelope router.

## Gotchas
- Profile-owned root instructions render as marked blocks; text outside is human-owned. Pi keeps
  instructions inside its Golem render and injects them per turn without profile writes.
- Claude runs cached render bytes: sync + version bump + `/reload-plugins`; render is not install.
- Role cards render for cc, codex, opencode, and Pi; Pi deliberately ships only
  builder/explorer/reviewer. Agent personas were scrubbed (no substrate/agents/);
  adapters tolerate the missing dir.
- opencode is bound to this checkout; its `plugin[]` names the shim by absolute path.
- Bare Codex is pull-only; `golem codex` is private; raw role/interrupt/halt stay gated.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill / plugin / instructions | `substrate/`, `lib/compiler/` | `golem sync --target cc --out ./plugin --check` |
| Sessions / hooks | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, OC shim | `node test/cross-harness-matrix.test.mjs` |
