# REPO-MAP.md
> Last verified: 2026-07-10 @ f1db53d — maintained via golem:docs-maintenance.

## Directory structure
- `substrate/` — source of truth for plugin content.
- `plugin/` — generated Claude Code render; never hand-edit.
- `cli/` — thin `golem` command entry point.
- `lib/` — runtime, role, compiler, lint, and LSP helpers.
- `dashboard/server/` — Fastify API and sole `tracker.db` owner.
- `dashboard/web/` — no-bundler React globals.
- `mcp/channel/` — per-session HTTP/MCP channel server.
- `shims/opencode/` — maps opencode events into hook/session registries.
- `test/` — journey tests for CLI/compiler enforcement paths.
- `golem-projects/` — independent checkouts.
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
- SessionStart registers, journals, and injects LSP, Team, and role-card context.
### `substrate/instructions/`
- Global AGENTS spine renders as managed blocks; outside-marker user text survives sync.
### `substrate/skills/`
- Role SOPs: `managing`, `planning`, `exploring`, `building`, `consulting` — single SoT per role; AGENTS and role cards reference only.
### `substrate/roles/`
- Shallow role cards injected at SessionStart.
### `mcp/channel/index.js`
- Exposes work briefs, role assignments, replies, consults, gates, and tracker tools per live session.

## Data flow
Hooks/shims write `~/.golem/` registries and journals; dashboard owns `tracker.db`, exposes rosters, and broadcasts state. Tracker MCP tools call REST; dispatch pushes to channels.

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
