# REPO-MAP.md
> Last verified: 2026-07-06 @ GOL-315 — maintained via golem:docs-maintenance.

## Directory structure
- `substrate/` — plugin source of truth: agents, skills, roles, hooks, MCP.
- `plugin/` — generated Claude Code render; refresh via `golem sync --target cc --out ./plugin --force`.
- `cli/` — thin `golem` CLI: dashboard, sync, role, doctor, status, migrate-home.
- `lib/` — runtime-path, project-id, role, compiler, and LSP libraries.
- `dashboard/server/` — Fastify REST/WS server; sole `tracker.db` owner; phase, bus, team assist.
- `dashboard/web/` — no-bundler React globals and Babel scripts.
- `mcp/channel/` — per-session server for briefs, gates, consults, tracker.
- `shims/opencode/` — maps opencode events into hook/session registries.
- `golem-projects/` — independent checkouts; not this repo's source tree.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; tracker mutations and hook ingest rebroadcast through `broadcastWS`.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` is a derived board cache.
- Schema invariant: phases v10, hook UUIDs v11, dispatch workspace v12.
- Team assists suggest least-loaded manager/explorer; never auto-dispatch.
### `dashboard/server/native-sessions.js`
- Merges hook-written `sessions.json` with Claude/opencode registries.
- Invariant: hooks/shims write registration; dashboard only reads/enriches.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, then injects tracker working-model and LSP hints.
### `mcp/channel/index.js`
- Exposes channel replies, consults, gates, and tracker tools per live session.

## Data flow
Hooks/shims write sessions, channels, and journals under `~/.golem/`; `journal-route.sh` also forwards hook events to `/api/bus/ingest` with spool fallback. Dashboard polls sessions, owns `tracker.db`, drains dispatches/subscription digests, exposes team rosters/suggestions, and broadcasts WS state. Tracker MCP tools call REST; dispatch pushes briefs to channels.

## Constraints & gotchas
- Claude Code loads `~/.golem/renders/cc-plugin`; sync + update + `/reload-plugins` after substrate edits.
- Dashboard `.jsx` files are globals; duplicate top-level names shadow by load order.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill | `substrate/skills/<name>/SKILL.md` | `golem sync --target cc --check` |
| Plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| API/tracker | `dashboard/server/index.js`, `tracker-db.js`, `phase-machine.js`, `team-assist.js` | `npm run check:dashboard` |
| Dashboard UI | `dashboard/web/src/*.jsx`, `index.html` | headless smoke via `_chrome.mjs` |
| Session registration | `substrate/hooks/session-register.sh`, shims | fresh session |
