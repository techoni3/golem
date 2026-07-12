# REPO-MAP.md
> Last verified: 2026-07-13 @ 6234e1d — maintained via golem:docs-maintenance.
## Directory structure
- `substrate/` — plugin source of truth.
- `plugin/` — generated CC render; never hand-edit.
- `cli/` — thin `golem` command entry point.
- `lib/` — runtime, role, compiler, lint, LSP helpers.
- `dashboard/server/` — Fastify API and `tracker.db` owner.
- `dashboard/web/` → `dashboard/dist/` — Vite-built React UI served as a pinned production artifact.
- `mcp/channel/` — per-session HTTP/MCP channel.
- `shims/opencode/` — maps events into hook/session registries.
- `docs/architectures/` — versioned standalone architecture field guides.
- `test/` — journey tests for CLI/compiler enforcement paths.
- `golem-projects/` — repos.
- `.worktrees/` — gitignored; explicit dispatches only.

## Key modules & entry points
### `dashboard/server/index.js`
- Registers REST/WS; envelope health is read-only and fact changes rebroadcast.
- Invariant: agents use HTTP/MCP, never direct DB writes.
### `tracker-db.js` + `phase-machine.js` + `team-assist.js`
- Phase is source of truth; `state` derives from it.
- Schema v10 phases through v15 cursors.
- Assists suggest; never dispatch.
### `dashboard/server/native-sessions.js`
- Merges hook-written `sessions.json` with harness registries.
- Hooks/shims own registration; dashboard may materialize bus status into existing rows.
- `lib/session-facts.js` owns identity/freshness; endpoint leases replace PID-only reachability.
### `substrate/hooks/*.sh`
- SessionStart registers, journals, and contextualizes; prompts add passive deltas.
### `substrate/instructions/`
- Managed global AGENTS blocks preserve user text.
### `substrate/skills/`
- Role SOPs are the single source of truth for each role.
### `substrate/roles/`
- Shallow role cards injected at SessionStart.
### `mcp/channel/index.js`
- Exposes briefs, roles, replies, consults, gates, and tracker tools.

## Data flow
Hooks/shims write `~/.golem/`; dashboard owns `tracker.db`. Envelope health derives from facts. Passive slots land on real turns or successful envelopes; subscription digests are quiet by default.

## Constraints & gotchas
- Claude runs cached render bytes; sync + update + `/reload-plugins` after edits.
- Dashboard `.jsx` files publish globals; `web/src/entry.jsx` preserves dependency order while Vite bundles browser dependencies locally.
- `plugin/` is a render target, not the source of truth; hand edits there are overwritten.
- Worktree builders self-check; manager/planner reconciles.

## Common tasks
| Task | Files | Verify with |
|------|-------|-------------|
| Skill/plugin | `substrate/`, `plugin/` | `golem sync --target cc --out ./plugin --check` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | `npm run dashboard:build`, isolated browser journey |
| Sessions | `substrate/hooks/`, shims | fresh session |
| Instructions | `substrate/instructions/`, `lib/compiler/` | temp-HOME sync smoke |
