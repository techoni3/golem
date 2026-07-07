# REPO-MAP.md
> Last verified: 2026-07-06 @ 88cabcc — maintained via golem:docs-maintenance.

## Directory structure
- `substrate/` — source of truth: agents, skills, roles, hooks, MCP, instructions.
- `plugin/` — generated Claude Code render; never hand-edit.
- `cli/` — thin `golem` CLI: dashboard, sync, role, doctor, status.
- `lib/` — runtime-path, role, compiler, substrate-lint, LSP libraries.
- `dashboard/server/` — Fastify REST/WS; sole `tracker.db` owner.
- `dashboard/web/` — no-bundler React globals.
- `mcp/channel/` — per-session server for briefs, gates, consults, tracker.
- `shims/opencode/` — maps opencode events into hook/session registries.
- `test/` — journey tests for CLI/compiler enforcement paths.
- `golem-projects/` — independent checkouts; not this repo.
- `.worktrees/` — gitignored builder checkouts; explicit dispatches only.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; tracker/hook ingest rebroadcast through `broadcastWS`.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` is derived.
- Schema invariant: phases v10, hook UUIDs v11, dispatch workspace v12.
- Team assists suggest least-loaded roles; never auto-dispatch.
### `dashboard/server/native-sessions.js`
- Merges hook-written `sessions.json` with harness registries.
- Invariant: hooks/shims write registration; dashboard only reads/enriches.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, then injects tracker working-model and LSP hints.
### `substrate/instructions/`
- Global instructions render as managed blocks or plain hook context files; outside-marker user text must survive sync.
### `mcp/channel/index.js`
- Exposes channel replies, consults, gates, and tracker tools per live session.

## Data flow
Hooks/shims write sessions, channels, and journals under `~/.golem/`; `journal-route.sh` forwards hook events to bus ingest with spool fallback. Dashboard owns `tracker.db`, drains dispatches/digests, exposes rosters, and broadcasts WS state. Tracker MCP tools call REST; dispatch pushes briefs to channels.

## Constraints & gotchas
- Claude Code loads `~/.golem/renders/cc-plugin`; sync + update + `/reload-plugins` after substrate edits.
- Dashboard `.jsx` files are globals; duplicate top-level names shadow by load order.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Worktree builders self-check; manager/planner reconciles on main.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill/plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | smoke/check scripts |
| Sessions | `substrate/hooks/`, shims | fresh session |
| Instructions | `substrate/instructions/`, `lib/compiler/` | temp-HOME sync smoke |
