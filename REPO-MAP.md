# REPO-MAP.md
> Last verified: 2026-07-25 @ 21dc9fe — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source; design labs stay isolated. `instructions/AGENTS.md` § Roles is the
  single source of role ownership; role cards and role skills point at it, never restate it.
- `plugin/` — generated CC render; never hand-edit. Note `sync --out ./plugin` does **not** prune
  removed sources — delete stale dirs by hand.
- `.claude/skills/` — golem-repo-only skills (not shipped). `substrate-doctrine` is the must-load
  before editing instructions, roles, or skills.
- `cli/` — `golem` command entry point.
- `lib/` — runtime, role, compiler, and managed-harness helpers.
- `dashboard/server/` — Fastify API and tracker owner.
- `dashboard/web/` → `dashboard/dist/` — React production artifact.
- `mcp/channel/` — channel server.
- `shims/opencode/` — maps events into registries.
- `test/` — journey tests.

## Key modules & entry points
### `cli/golem.js`
- `golem claude` fixes the plugin channel; Claude keeps native args/CWD and has no supervisor.
### `dashboard/server/index.js`
- Registers REST/WS; uniquely resolves project names; agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it; assists suggest but never dispatch.
### `dashboard/server/comment-dispatch.js` + `subscription-reaper.js`
- Comment dispatch is durable-first then rolled back on an undelivered push (502, comments return to `undispatched`); the reaper suspends subscriptions of sessions absent from the native roster, because only a graceful CC `SessionEnd` ever suspended them.
### `dashboard/server/native-sessions.js`
- Merges registries with facts; Codex owns presentation and facts own freshness/leases. Supervisor thread mappings collapse raw twins even when a lease is down.
### `lib/codex-supervisor.js` + `lib/codex-tui-bridge.js`
- Pinned App Server owner; the private TUI bridge preserves native approvals and targets only idle canonical threads.
### `shims/codex/hook.mjs` + `lib/session-registry.js`
- Codex SessionStart registers and supersedes prior same-project rows; documented hooks record facts.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.

## Data flow
Hooks/shims write `~/.golem/` registries; dashboard owns routes. `golem claude` enables CC push; managed Codex uses typed turns. Native/dispatchable rows distinguish presence from readiness.

## Constraints & gotchas
- Root instructions render as a **marked block** (`<!-- golem:instructions:begin -->`) into each
  harness's own global file: `~/.claude/CLAUDE.md` (cc), `$CODEX_HOME/AGENTS.md` (codex),
  opencode's `AGENTS.md`. Text outside the markers belongs to the human and is never rewritten;
  adoption of a pre-existing file appends and never truncates. `pi` has no instruction surface.
- Claude runs cached render bytes; sync + update + `/reload-plugins` after edits.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Bare Codex is pull-only; `golem codex` is private. Raw role/interrupt/halt stay gated.
- Agent/project passport cards cap at 520px; never use `1fr` tracks.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill/plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | `npm run dashboard:build`, isolated browser journey |
| Comment dispatch / subscriptions | `comment-dispatch.js`, `subscription-reaper.js`, `ticket-drawer.jsx` | `node test/subscription-reaper.test.mjs`, `node dashboard/scripts/smoke-gol-101.mjs` |
| Sessions | `substrate/hooks/`, shims | fresh session |
| Cross-harness delivery | supervisor, `mcp/channel/`, dashboard, OC shim | `node test/cross-harness-matrix.test.mjs` |
| Managed Codex controls | supervisor, tracker envelopes, dashboard | `node test/codex-control-plane.test.mjs` |
| Managed Codex TUI | supervisor, `codex-tui-bridge.js`, CLI | `node test/codex-tui-bridge.test.mjs` |
| Instructions | `substrate/instructions/`, `lib/compiler/` | temp-HOME sync smoke |
