# REPO-MAP.md
> Last verified: 2026-07-04 @ 7111dcc — maintained via golem:docs-maintenance.

## Directory structure
- `substrate/` — plugin source of truth: agents, skills, roles, hooks, MCP.
- `plugin/` — generated Claude Code render; refresh with `golem sync --target cc --out ./plugin --force`.
- `cli/` — thin `golem` CLI: dashboard, sync, role, doctor, status, migrate-home.
- `lib/` — shared runtime-path, project-id, role, compiler, and LSP libraries.
- `dashboard/server/` — Fastify REST/WS server; sole `~/.golem/tracker.db` owner.
- `dashboard/web/` — no-bundler React UI loaded as globals and Babel scripts.
- `mcp/channel/` — per-session server for briefs, gates, consults, tracker.
- `shims/opencode/` — maps opencode events into hook/session registries.
- `golem-projects/` — independent checkouts; not this repo's source tree.
- `project_management/` — historical planning only.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST routes and `/ws`; tracker mutations rebroadcast through `broadcastWS`.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `dashboard/server/native-sessions.js`
- Merges hook-written `~/.golem/sessions.json` with Claude/opencode registries.
- Invariant: hooks/shims write registration; dashboard only reads/enriches.
### `lib/session-role.js`
- Defines `SESSION_ROLES`, runtime role-card overlays, assignment, and role brief push.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, then injects tracker working-model and LSP hints.
### `mcp/channel/index.js`
- Exposes channel replies, consults, gates, and tracker tools per live session.

## Data flow
Hooks/shims write sessions, channels, and journals under `~/.golem/`; dashboard polls sessions, owns `tracker.db`, drains dispatches, and broadcasts WS state. Tracker MCP tools call REST; dispatch pushes briefs to the target channel.

## Constraints & gotchas
- Runtime state is in `~/.golem/`; `~/.config/golem` is only a compatibility symlink.
- Claude Code loads `~/.golem/renders/cc-plugin`; sync + update + `/reload-plugins` after substrate edits.
- Dashboard `.jsx` files are globals; duplicate top-level names shadow by load order.
- esm.sh imports must share one React instance via the import map.
- Smoke/probe scripts must use `dashboard/scripts/_chrome.mjs`, never the user's Chrome on 9222.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill | `substrate/skills/<name>/SKILL.md` | `golem sync --target cc --check` |
| Plugin behavior | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| API/tracker | `dashboard/server/index.js`, `tracker-db.js` | `npm run check:dashboard` |
| Dashboard UI | `dashboard/web/src/*.jsx`, `index.html` | headless smoke via `_chrome.mjs` |
| Session registration | `substrate/hooks/session-register.sh`, shims | fresh session |
